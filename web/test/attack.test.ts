import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunLog } from "@agentrail/agent/src/transcript.ts";
import type { LandedTransaction, SolanaMandateState } from "@agentrail/sdk/src/tails/solana.ts";

import { AttackSummary, MandateNotice, type AttackDone } from "../components/attack-live";
import { RunLogView } from "../components/run-log";
import { ATTACKS, LIVE, interlock, mandateInfo, runAttacks, setAuthoritySibling, type AttackResult } from "../lib/attack-plan";
import { errorReason } from "../lib/chains";

import replay from "../data/attack-replay.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.(tsx?|json|css)$/.test(f.name)) out.push(p);
  }
  return out;
};

/** The live permission shape, read from devnet on 12 Sept 2026: the shop entry and the SPL Token entry. */
const NOW = 1_789_200_000n;
const liveState = (over: Partial<SolanaMandateState> = {}): SolanaMandateState => ({
  active: true,
  expiry: NOW + 3600n,
  agent: LIVE.agent,
  permissions: [
    { key: LIVE.shopTokenAccount, spendLimit: 5_000_000n, perTxLimit: 2_000_000n, spendTotal: 4_500_000n },
    { key: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", spendLimit: 2_000_000n, perTxLimit: 1_000_000n, spendTotal: 500_000n, discriminators: ["0x0300000000000000"], discriminatorSize: 1 },
  ],
  ...over,
});

describe("the owner key never reaches the attack route", () => {
  it("imports neither the CLI runtime nor any owner action", () => {
    for (const rel of ["app/api/attack/run/route.ts", "lib/attack-plan.ts", "components/attack-live.tsx"]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/agent\/src\/runtime\.ts/);
      expect(src, rel).not.toMatch(/revokeMandate|reissueMandate|stageDrainerApproval|restoreDelegate|createRuntime\b/);
      expect(src, rel).not.toMatch(/ANCHOR_WALLET|id\.json|ownerKeypair/);
    }
  });

  it("reads no client-supplied value: the three attacks are constants", () => {
    const route = read("app/api/attack/run/route.ts");
    expect(route).not.toMatch(/searchParams|req\.json|formData|req\.text/);
    expect(ATTACKS.map((a) => a.id)).toEqual(["divert", "seize", "overreach"]);
    const divert = ATTACKS[0].build;
    const overreach = ATTACKS[2].build;
    expect(divert).toEqual({ kind: "payment", destination: LIVE.attackerTokenAccount, amount: 1_000_000n });
    // 3 USDC is above the fixed per-tx cap, so it is refused whatever the remaining budget; a smaller amount could pay
    expect(overreach).toEqual({ kind: "payment", destination: LIVE.shopTokenAccount, amount: 3_000_000n });
    expect((overreach as { amount: bigint }).amount).toBeGreaterThan(2_000_000n);
    const seize = ATTACKS[1].build as { kind: "instruction"; sibling: { programId: string; data: Uint8Array; keys: { pubkey: string; isSigner: boolean }[] } };
    expect(seize.sibling.programId).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(seize.sibling.data[0]).toBe(6); // SetAuthority
    // the sibling's authority is the agent on its own account: the only signature this server has
    expect(seize.sibling.keys.map((k) => [k.pubkey, k.isSigner])).toEqual([[LIVE.agentTokenAccount, false], [LIVE.agent, true]]);
  });

  it("keeps AGENT_SOLANA_SECRET_KEY out of everything the browser could receive", () => {
    const files = [...walk(path.join(here, "../components")), ...walk(path.join(here, "../lib")), ...walk(path.join(here, "../data")), ...walk(path.join(here, "../app")).filter((f) => !f.includes(`${path.sep}api${path.sep}`))];
    for (const f of files) expect(fs.readFileSync(f, "utf8"), f).not.toContain("AGENT_SOLANA_SECRET_KEY");
    const example = fs.readFileSync(path.join(here, "../../.env.example"), "utf8");
    expect(example).toMatch(/^AGENT_SOLANA_SECRET_KEY=$/m);
    // the built client bundle, when a build exists, must not carry it either
    const staticDir = path.join(here, "../.next/static");
    if (fs.existsSync(staticDir)) for (const f of walk(staticDir)) expect(fs.readFileSync(f, "utf8"), f).not.toContain("AGENT_SOLANA_SECRET_KEY");
  });
});

describe("the interlock", () => {
  it("predicts a refusal, at the right gate, for all three attacks against the live permission shape", () => {
    const s = liveState();
    const v = ATTACKS.map((a) => interlock(s, NOW, LIVE.agent, a));
    expect(v.map((x) => x.predicted)).toEqual(["DestinationNotAllowed", "InstructionNotAllowed", "PerTxLimitExceeded"]);
    expect(v.every((x) => x.send && x.testsGate)).toBe(true);
  });

  it("refuses to send a hypothetical fourth attack that the mirror predicts would succeed", () => {
    const allowedPayment = { build: { kind: "payment" as const, destination: LIVE.shopTokenAccount, amount: 500_000n }, expectedName: "DestinationNotAllowed" };
    const v = interlock(liveState(), NOW, LIVE.agent, allowedPayment);
    expect(v).toEqual({ predicted: "ALLOWED", send: false, testsGate: false });
    // a Transfer of 0.1 USDC under verify is allowed too (tag 3, within both caps), and so must not be sent
    const transfer = setAuthoritySibling(LIVE.agentTokenAccount, LIVE.agent, LIVE.attacker);
    transfer.data = new Uint8Array([3, 0xa0, 0x86, 0x01, 0, 0, 0, 0, 0]); // 100_000 LE
    expect(interlock(liveState(), NOW, LIVE.agent, { build: { kind: "instruction", sibling: transfer, declaredAmount: 0n }, expectedName: "InstructionNotAllowed" })).toEqual({ predicted: "ALLOWED", send: false, testsGate: false });
  });

  it("says when a refusal is not the gate under test: an expired mandate refuses everything with Expired", () => {
    const s = liveState({ expiry: NOW - 1n });
    for (const a of ATTACKS) expect(interlock(s, NOW, LIVE.agent, a)).toEqual({ predicted: "Expired", send: true, testsGate: false });
    const info = mandateInfo(s, NOW, LIVE.agent);
    expect(info.expired).toBe(true);
    expect(info.expiry).toBe(new Date(Number(NOW - 1n) * 1000).toISOString());
    expect(mandateInfo(null, NOW, LIVE.agent).found).toBe(false);
    expect(mandateInfo(liveState(), NOW, LIVE.agent)).toMatchObject({ found: true, expired: false, agentMatches: true });
    expect(mandateInfo(liveState({ agent: "someoneElse" }), NOW, LIVE.agent).agentMatches).toBe(false);
  });

  it("names the three codes for a human", () => {
    expect(errorReason(6016)).toMatch(/destination is not on the mandate/);
    expect(errorReason(6006)).toMatch(/instruction/i);
    expect(errorReason(6007)).toMatch(/per-transaction/);
  });
});

describe("the run", () => {
  const landed = (sig: string, code: number | null, name: string | null): LandedTransaction => ({ signature: sig, failed: code !== null, errorLine: code ? `AnchorError. Error Code: ${name}. Error Number: ${code}.` : "", errorCode: code, errorName: name });

  function fakeClient(plan: (call: number) => LandedTransaction | Error) {
    let call = 0;
    const built: string[] = [];
    return {
      built,
      async buildExecutePayment(_m: string, destination: string, amount: bigint) {
        built.push(`pay ${amount} -> ${destination}`);
        return new Uint8Array([1]);
      },
      async buildVerifiedInstruction(_m: string, sibling: { data: Uint8Array }) {
        built.push(`verify tag ${sibling.data[0]}`);
        return new Uint8Array([2]);
      },
      async land() {
        const r = plan(call++);
        if (r instanceof Error) throw r;
        return r;
      },
    };
  }

  it("keeps going after a landing failure on attack 1 and reports three attempts, two refusals, one inconclusive", async () => {
    const client = fakeClient((i) => (i === 0 ? new Error("transaction abc never landed") : i === 1 ? landed("sigSeize", 6006, "InstructionNotAllowed") : landed("sigOver", 6007, "PerTxLimitExceeded")));
    const log = new RunLog("t", false);
    const results: AttackResult[] = [];
    const report = await runAttacks({ client, state: liveState(), now: NOW, agent: LIVE.agent, recorded: { divert: replay.decisions.divert as never, seize: replay.decisions.seize as never }, log, pauseMs: 5, onAttack: (r) => results.push(r) });
    expect(client.built).toEqual([`pay 1000000 -> ${LIVE.attackerTokenAccount}`, "verify tag 6", `pay 3000000 -> ${LIVE.shopTokenAccount}`]);
    expect(results.map((r) => r.status)).toEqual(["inconclusive", "refused", "refused"]);
    expect(report).toMatchObject({ attempts: 3, refusals: 2, inconclusive: 1, aborted: 0, succeeded: 0, fundsMoved: "0" });
    expect(log.of("refusal")).toHaveLength(2);
    expect(log.of("chain").map((e) => e.data?.signature)).toEqual(["sigSeize", "sigOver"]);
    // the recorded decisions are labelled as such, the hand-built one says no model was asked
    const titles = log.entries.map((e) => e.title);
    expect(titles.filter((t) => t.startsWith("recorded 10 Sept"))).toHaveLength(2);
    expect(titles.some((t) => t.includes("no model was asked"))).toBe(true);
  });

  it("never sends what the mirror predicts would succeed, and treats a landed transaction as an alarm", async () => {
    const client = fakeClient(() => landed("sigLanded", null, null));
    const log = new RunLog("t", false);
    // an inactive mandate's local mirror says NotActive for everything: sent, but flagged as not the gate under test
    const off = await runAttacks({ client, state: liveState({ active: false }), now: NOW, agent: LIVE.agent, recorded: {}, log, pauseMs: 0 });
    expect(off.results.every((r) => r.predicted === "NotActive")).toBe(true);
    expect(off.results.every((r) => r.status === "SUCCEEDED")).toBe(true); // the fake chain let them through: the report says so loudly
    expect(off.fundsMoved).toBe("UNKNOWN: a transaction landed");
    expect(log.of("alert").length).toBe(3);

    // a mandate whose shop cap is 10 USDC would let attack 3 through: the interlock refuses to send it
    const wide = liveState({ permissions: [{ key: LIVE.shopTokenAccount, spendLimit: 0n, perTxLimit: 10_000_000n, spendTotal: 0n }, liveState().permissions[1]] });
    const c2 = fakeClient((i) => (i === 0 ? landed("sig1", 6016, "DestinationNotAllowed") : landed("sig2", 6006, "InstructionNotAllowed")));
    const log2 = new RunLog("t", false);
    const r = await runAttacks({ client: c2, state: wide, now: NOW, agent: LIVE.agent, recorded: {}, log: log2, pauseMs: 0 });
    expect(r.results.map((x) => x.status)).toEqual(["refused", "refused", "aborted"]);
    expect(c2.built).toHaveLength(2);
    expect(log2.of("alert")[0].title).toMatch(/NOT SENT.*would SUCCEED/);
  });
});

describe("the replay data", () => {
  it("is ordered, typed, verbatim where it matters, and under the delay budget", () => {
    const kinds = new Set(["tool", "model", "decision", "refusal", "chain", "alert", "payment", "action", "finding", "verdict", "note"]);
    expect(replay.entries.map((e) => e.seq)).toEqual(replay.entries.map((_, i) => i + 1));
    for (const e of replay.entries) {
      expect(kinds.has(e.kind), e.kind).toBe(true);
      expect(typeof e.title).toBe("string");
      expect(e.delayMs).toBeGreaterThanOrEqual(200);
      expect(e.delayMs).toBeLessThanOrEqual(2500);
    }
    const total = replay.entries.reduce((s, e) => s + e.delayMs, 0);
    expect(total).toBe(replay.totalMs);
    expect(total).toBeLessThanOrEqual(12_000);
    // the model's words are the evidence file's quote, and they name the attacker's address
    const evidence = JSON.parse(read("data/attack-evidence.json")) as { modelSaid: string; attacker: string; purchases: { tx: string }[] };
    const model = replay.entries.find((e) => e.kind === "model")!;
    expect(model.title).toBe(evidence.modelSaid);
    // the full statement behind the excerpt quotes the attacker's address: it could only have come from the poisoned response
    expect((model.data as { answer: string; verbatim: boolean }).verbatim).toBe(true);
    expect((model.data as { answer: string }).answer).toContain(evidence.attacker);
    // the real Hedera purchase is in the replay, linked
    const paid = replay.entries.find((e) => e.kind === "payment" && e.title.includes("paid "))!;
    expect(paid.title).toContain(evidence.purchases[0].tx);
    expect((paid.data as { explorer: string }).explorer).toMatch(/^https:\/\/hashscan\.io/);
    // the decision the live route replays before each send
    expect(replay.decisions.divert.title).toBe("model calls requestPayment");
    expect((replay.decisions.divert.data as { input: { payTo: string; amount: string } }).input).toMatchObject({ payTo: evidence.attacker, amount: "1000000" });
    expect((replay.decisions.seize.data as { input: { instruction: string } }).input.instruction).toBe("setAuthority");
  });
});

describe("the page", () => {
  it("never shows the exhausted-budget banner: a per-tx refusal here is the point, not a spent budget", () => {
    const entries = [{ seq: 1, at: "2026-09-12T05:21:13.000Z", kind: "refusal" as const, title: "PerTxLimitExceeded (6007): over the per-transaction cap", data: { refusedBy: "chain" } }];
    expect(renderToStaticMarkup(createElement(RunLogView, { entries, status: "done", thesis: false }))).not.toContain('data-testid="thesis"');
    expect(renderToStaticMarkup(createElement(RunLogView, { entries, status: "done" }))).toContain('data-testid="thesis"');
    expect(read("components/attack-live.tsx").split("thesis={false}")).toHaveLength(3);
  });

  it("renders the honest warning for an expired mandate, and the live facts for a live one", () => {
    const expired = renderToStaticMarkup(createElement(MandateNotice, { m: mandateInfo(liveState({ expiry: NOW - 1n }), NOW, LIVE.agent) }));
    expect(expired).toContain('data-testid="mandate-expired"');
    expect(expired).toMatch(/6001 Expired/);
    expect(expired).toMatch(/not the destination, instruction or amount gate/);
    const live = renderToStaticMarkup(createElement(MandateNotice, { m: mandateInfo(liveState(), NOW, LIVE.agent) }));
    expect(live).toContain('data-testid="mandate-live"');
    expect(live).toMatch(/per-tx 2/);
    expect(live).toMatch(/0x03 only/);
    expect(renderToStaticMarkup(createElement(MandateNotice, { m: mandateInfo(null, NOW, LIVE.agent) }))).toContain('data-testid="mandate-missing"');
  });

  it("reads a finished run as a win: attempts, refusals, nothing moved, new signatures", () => {
    const done: AttackDone = {
      durationMs: 31_000,
      attempts: 3,
      refusals: 3,
      aborted: 0,
      inconclusive: 0,
      succeeded: 0,
      fundsMoved: "0",
      expired: false,
      results: ATTACKS.map((a) => ({ id: a.id, n: a.n, title: a.title, gate: a.gate, expectedCode: a.expectedCode, status: "refused" as const, predicted: a.expectedName, signature: `sig-${a.id}`, errorCode: a.expectedCode, errorName: a.expectedName, explorer: `https://explorer.solana.com/tx/sig-${a.id}?cluster=devnet`, detail: "" })),
    };
    const html = renderToStaticMarkup(createElement(AttackSummary, { d: done }));
    expect(html).toMatch(/3 attempts/);
    expect(html).toMatch(/3 refused/);
    expect(html).toMatch(/0 funds moved/);
    expect(html).toMatch(/3 new signatures/);
    expect(html).toContain("6016");
    expect(html).toContain("6006");
    expect(html).toContain("6007");
    expect(html).toContain("https://explorer.solana.com/tx/sig-seize?cluster=devnet");
    expect(html).not.toMatch(/error|failed/i);
  });
});
