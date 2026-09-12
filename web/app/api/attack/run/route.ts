/**
 * GET /api/attack/run
 *
 * The live half of /attack. Three attack instructions, fixed in `lib/attack-plan.ts`, are sent to
 * the databot mandate on Solana devnet and refused by the program while the reader watches; the
 * request carries nothing that reaches a transaction. The route signs as the real agent, because
 * `execute_payment` checks NotTheAgent before the destination: a throwaway key would prove
 * nothing. That key holds no tokens and is a delegate on nothing; every movement of value goes
 * through the mandate PDA, so a stolen copy could do no more than the mandate allows. It is read
 * from `AGENT_SOLANA_SECRET_KEY` here and nowhere else. The owner key never reaches this server:
 * the route does not import the CLI runtime and there is no revoke, reissue, approve or restore.
 *
 * Events: start · mandate (expiry first) · entry (one per RunLog entry) · attack · done · failed.
 */
import { RunLog, stringify, type Entry } from "@agentrail/agent/src/transcript.ts";
import { createAnchorGateClient } from "@agentrail/sdk/src/solana/anchorClient.ts";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { ATTACKS, LIVE, mandateInfo, runAttacks, type AttackResult } from "@/lib/attack-plan";
import { serverEnv } from "@/lib/env";
import { firstLine } from "@/lib/redact";
import { createRunLock } from "@/lib/run-lock";

import replay from "@/data/attack-replay.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Three sends with confirmation and a paced public RPC: about half a minute; the ceiling is the plan's. */
export const maxDuration = 300;

const lock = createRunLock({ cooldownMs: 20_000, cost: "each run sends three transactions to a public RPC" });
const HEARTBEAT_MS = 15_000;
const PAUSE_BETWEEN_ATTACKS_MS = 1_500;

/** The agent keypair from the environment: the JSON byte array `solana-keygen` writes, or base58. Never logged, never echoed. */
function agentKeypair(): Keypair {
  const raw = process.env.AGENT_SOLANA_SECRET_KEY?.trim();
  if (!raw) throw new Error("AGENT_SOLANA_SECRET_KEY is not set on the server; the live attack cannot sign as the agent");
  let bytes: Uint8Array;
  try {
    if (raw.startsWith("[")) bytes = Uint8Array.from(JSON.parse(raw) as number[]);
    else {
      // base58, decoded without a dependency: the alphabet is fixed
      const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let n = 0n;
      for (const c of raw) {
        const i = A.indexOf(c);
        if (i < 0) throw new Error("not base58");
        n = n * 58n + BigInt(i);
      }
      const out: number[] = [];
      while (n > 0n) {
        out.unshift(Number(n & 255n));
        n >>= 8n;
      }
      for (const c of raw) {
        if (c !== "1") break;
        out.unshift(0);
      }
      bytes = Uint8Array.from(out);
    }
  } catch {
    throw new Error("AGENT_SOLANA_SECRET_KEY is not a JSON byte array or a base58 secret key");
  }
  if (bytes.length !== 64) throw new Error(`AGENT_SOLANA_SECRET_KEY has ${bytes.length} bytes; a Solana secret key has 64`);
  const kp = Keypair.fromSecretKey(bytes);
  if (kp.publicKey.toBase58() !== LIVE.agent) throw new Error(`AGENT_SOLANA_SECRET_KEY is ${kp.publicKey.toBase58()}, not the databot agent ${LIVE.agent}; refusing to sign`);
  return kp;
}

export async function GET(req: Request) {
  // no query parameter is read: the attacks are constants (attack-plan.ts), the request only starts the run
  const client = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  const lease = lock.acquire(client);
  if (!lease.ok) return Response.json({ error: lease.reason }, { status: lease.status, headers: { "Retry-After": String(Math.ceil(lease.retryAfterMs / 1000)) } });

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);
      const finish = () => {
        clearInterval(heartbeat);
        lease.release();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      };

      const log = new RunLog(`attack_${new Date(startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19)}`, false);
      log.onEntry = (entry: Entry) => send("entry", entry);

      (async () => {
        send("start", { run: lease.id, at: new Date(startedAt).toISOString(), attacks: ATTACKS.map((a) => ({ id: a.id, n: a.n, title: a.title, gate: a.gate, expectedCode: a.expectedCode, expectedName: a.expectedName, why: a.why })), recordedAt: replay.recordedAt });
        try {
          const agent = agentKeypair();
          const connection = new Connection(serverEnv.solanaRpc(), "confirmed");
          // the agent pays its own fee: this server holds no other key
          const gate = createAnchorGateClient({ connection, agent, feePayer: agent, ownerTokenAccount: new PublicKey(LIVE.ownerTokenAccount) });
          const [state, now] = await Promise.all([gate.readMandate(LIVE.mandate), gate.now()]);
          const info = mandateInfo(state, now, LIVE.agent);
          send("mandate", { ...info, mandate: LIVE.mandate, agent: LIVE.agent, program: LIVE.program });
          log.add("note", !info.found ? `mandate ${LIVE.mandate} not found: the owner has not issued one` : `mandate live: expires ${info.expiry}${info.expired ? " — EXPIRED: every refusal below is 6001 Expired, not the gate under test" : ""}, ${info.permissions.length} permission(s), active=${info.active}`, { expiry: info.expiry, expired: info.expired, permissions: info.permissions.map((p) => `${p.key} per-tx ${p.perTxLimit} spent ${p.spendTotal}/${p.spendLimit}${p.discriminators.length ? ` discriminators ${p.discriminators.join(",")}` : ""}`) });

          const report = await runAttacks({
            client: gate,
            state,
            now,
            agent: LIVE.agent,
            recorded: { divert: replay.decisions.divert as never, seize: replay.decisions.seize as never },
            recordedAt: replay.recordedAt,
            log,
            pauseMs: PAUSE_BETWEEN_ATTACKS_MS,
            onAttack: (r: AttackResult) => send("attack", r),
          });
          log.add("verdict", report.succeeded > 0 ? `ALARM: ${report.succeeded} transaction(s) landed. Funds may have moved.` : `${report.attempts} attacks, ${report.refusals} refusals, 0 funds moved${report.inconclusive ? `, ${report.inconclusive} inconclusive` : ""}${report.aborted ? `, ${report.aborted} not sent` : ""}`, { signatures: report.results.filter((r) => r.signature).length, refused: report.results.filter((r) => r.status === "refused").map((r) => `${r.n}: ${r.errorName} ${r.errorCode}`) });
          send("done", { durationMs: Date.now() - startedAt, entries: log.entries.length, ...report, expired: info.expired });
        } catch (e) {
          send("failed", { durationMs: Date.now() - startedAt, entries: log.entries.length, message: firstLine(e) });
        } finally {
          finish();
        }
      })();
    },
    cancel() {
      lease.release();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
