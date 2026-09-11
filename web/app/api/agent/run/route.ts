/**
 * GET /api/agent/run?name=<agent ENS name>&wallet=<0x…>
 *
 * One click, one monitor pass, streamed as Server-Sent Events while it happens. The route calls
 * `runMonitor` and nothing else: no attack, no defend, no mode parameter, no code path to either.
 * The runtime is the agent-only one (agent keys from the server environment, the mandates the owner
 * already issued, Solana read-only), so nothing here can make the owner sign. Every key stays on
 * the server; the browser receives log entries.
 *
 * Events: start · ready · entry (one per RunLog entry, the moment it is added) · done · failed.
 */
import { runMonitor } from "@agentrail/agent/src/monitor.ts";
import { createAgentRuntime } from "@agentrail/agent/src/runtime-agent.ts";
import { RunLog, stringify, type Entry } from "@agentrail/agent/src/transcript.ts";

import { looksLikeName, normalizeName } from "@/lib/ens";
import { PUBLIC } from "@/lib/env";
import { createRunLock } from "@/lib/run-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The most the plan allows; a run is 2-4 minutes. Everything streamed before a cut-off stays on screen. */
export const maxDuration = 300;

const lock = createRunLock({ cooldownMs: 20_000 });
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = normalizeName(url.searchParams.get("name") ?? PUBLIC.agentName);
  if (!looksLikeName(name)) return Response.json({ error: "name must be an ENS name" }, { status: 400 });
  const wallet = (url.searchParams.get("wallet") ?? PUBLIC.aliceWallet).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return Response.json({ error: "wallet must be an EVM address" }, { status: 400 });
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

      const log = new RunLog(`web_${new Date(startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19)}`, false);
      log.onEntry = (entry: Entry) => send("entry", entry);

      (async () => {
        send("start", { run: lease.id, name, wallet, at: new Date(startedAt).toISOString() });
        let rt: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
        try {
          // a serverless run has a hard ceiling: fewer tool steps per loop, the drills side by side
          rt = await createAgentRuntime({ agentName: name, log, exploreSteps: 10 });
          send("ready", { rails: rt.rails, feedService: rt.feedService, model: rt.provider?.model ?? null });
          const report = await runMonitor({
            wallet,
            tools: rt.tools,
            log,
            feedService: rt.feedService,
            knownSpenders: rt.solana ? [rt.solana.mandate] : [],
            ownerWallet: rt.solana?.owner,
            maxLendingDrills: 1,
            parallelDrills: true,
          });
          send("done", {
            durationMs: Date.now() - startedAt,
            entries: log.entries.length,
            toolCalls: log.of("tool").length,
            payments: log.of("payment").filter((e) => e.title.includes("paid ")).length,
            refusals: log.of("refusal").length,
            paidRequests: rt.paidRequests(),
            verdict: report.verdict,
            protocols: report.protocols.map((p) => p.name),
            purchase: report.purchase ? { status: report.purchase.status, transactionId: report.purchase.transactionId ?? null, explorer: report.purchase.explorer ?? null, reason: report.purchase.reason ?? null } : null,
          });
        } catch (e) {
          send("failed", { durationMs: Date.now() - startedAt, entries: log.entries.length, message: e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e) });
        } finally {
          try {
            await rt?.close();
          } catch {
            /* the MCP connection may already be gone */
          }
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
