import { describe, expect, it, vi } from "vitest";

import { approvalsQuestion, discoveryQuestion, runMonitor, type MonitorConfig } from "../src/monitor.ts";
import type { AgentTools, DiscoveredService, MandateView, PaymentOutcome } from "../src/tools.ts";
import { RunLog } from "../src/transcript.ts";

const NOW = 1_800_000_000;
const ALICE = "0xA11ce0000000000000000000000000000000A11c";
const DRAINER = "0xbad0000000000000000000000000000000000bad";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const MAX = ((1n << 256n) - 1n).toString();
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";

/** The MandateView getMyMandate would return for a healthy mandate. */
const mandateView = (over: Partial<MandateView> = {}): MandateView => ({
  ensNode: "0x320d",
  asOf: new Date(NOW * 1000).toISOString(),
  readVia: "fixed-query",
  chains: [
    { chain: "sepolia", url: "s", active: true, expiry: "0", permissions: [], actions: { total: 0, allowed: 0, blocked: 0, blockedReasons: {} } },
    { chain: "solana", url: "ss", active: true, expiry: "9999999999", permissions: [], actions: { total: 3, allowed: 1, blocked: 2, blockedReasons: { "6007": 1, "6006": 1 } } },
  ],
  recentActions: [],
  solana: { mandate: PDA, active: true, expiry: "9999999999", permissions: [] },
  ...over,
});

interface ScriptedAnswer {
  match: (q: string) => boolean;
  answer: string;
}

/** A fake tool surface: querySubgraph answers from a script keyed on the question, everything else is a spy. */
function fakeTools(script: ScriptedAnswer[], view: MandateView, payment?: PaymentOutcome) {
  const history = vi.fn(async () => view);
  const querySubgraph = vi.fn(async (question: string) => {
    const hit = script.find((s) => s.match(question));
    return { question, answer: hit?.answer ?? '{"protocols":[]}', model: "fake", steps: [] };
  });
  const requestPayment = vi.fn(async (): Promise<PaymentOutcome> => payment ?? { status: "paid", chain: "hedera:testnet", service: "feed.agentrail.eth", amount: "40000", transactionId: "0.0.7@1", paidRequestsSent: 1, data: [{ symbol: "ETH", price: 3000 }, { symbol: "USDT", price: 1 }] });
  const requestAction = vi.fn(async () => ({ status: "refused" as const, instruction: "revoke", tag: 5, program: "", account: "", reason: "InstructionNotAllowed", refusedBy: "local-gate" as const, sent: false }));
  const discoverService = vi.fn(async () => ({ name: "feed.agentrail.eth", chain: "hedera:testnet", url: "https://feed", price: 10000n, token: "0.0.429274", scheme: "x402", records: {} }) as DiscoveredService);
  const tools: AgentTools = { discoverService, querySubgraph, getMyMandate: history, requestPayment, requestAction };
  return { tools, history, querySubgraph, requestPayment };
}

const baseCfg = (tools: AgentTools, log: RunLog, over: Partial<MonitorConfig> = {}): MonitorConfig => ({ wallet: ALICE, tools, log, now: () => NOW, feedService: "feed.agentrail.eth", knownSpenders: [PDA], ...over });

describe("runMonitor", () => {
  it("does the discovery pass FIRST, then drills the protocols it found (no hardcoded protocol)", async () => {
    const script: ScriptedAnswer[] = [
      { match: (q) => q.includes("Which DeFi protocols"), answer: '{"protocols":[{"name":"Aave V3","kind":"lending","chain":"eip155:1","subgraphId":"C2zn","evidence":"has a borrow position"}]}' },
      { match: (q) => q.includes("On Aave V3"), answer: '{"positions":[{"protocol":"Aave V3","chain":"eip155:1","collateralUSD":12000,"debtUSD":11500,"healthFactor":1.04}]}' },
      { match: (q) => q.includes("Approval events"), answer: '{"approvals":[],"tried":["approvals-sg"]}' },
      { match: (q) => q.includes("transfers OUT"), answer: '{"transfers":[],"balances":[],"tried":["transfers-sg"]}' },
    ];
    const { tools, history, querySubgraph } = fakeTools(script, mandateView());
    const log = new RunLog("m", false);
    const report = await runMonitor(baseCfg(tools, log));

    // discovery came before the first drill
    const calls = querySubgraph.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain("Which DeFi protocols");
    expect(calls.some((q) => q.includes("On Aave V3"))).toBe(true);
    // budget was read with the fixed query (getMyMandate takes no argument; it binds ensNode internally)
    expect(history).toHaveBeenCalledTimes(1);
    expect(report.protocols.map((p) => p.name)).toEqual(["Aave V3"]);
    // R3 fired from the drilled position -> MEDIUM verdict
    expect(report.verdict.severity).toBe("MEDIUM");
    expect(report.findings.map((f) => f.rule)).toContain("R3");
    // the discovery log entry precedes any finding entry
    const order = log.entries.filter((e) => e.kind === "decision" || e.kind === "finding").map((e) => e.title);
    expect(order[0]).toContain("discovery pass");
  });

  it("detects the drainer approval on Alice's own delegated account and returns CRITICAL revoke", async () => {
    const script: ScriptedAnswer[] = [{ match: () => true, answer: '{"protocols":[]}' }];
    const view = mandateView({
      solana: { mandate: PDA, active: true, expiry: "9999999999", permissions: [], delegation: { account: "AzbP", delegate: DRAINER, delegatedAmount: MAX, balance: "94000000", delegateIsMandate: false, delegateTxCount: 0 } },
    });
    const { tools } = fakeTools(script, view);
    const log = new RunLog("m", false);
    const report = await runMonitor(baseCfg(tools, log, { ownerWallet: "55FJ" }));
    expect(report.verdict.severity).toBe("CRITICAL");
    const r1 = report.findings.find((f) => f.rule === "R1");
    expect(r1?.evidence).toMatchObject({ spender: DRAINER, unlimited: true, noHistory: true });
    expect(report.verdict.recommendedAction).toMatchObject({ kind: "revokeApproval", chain: "solana:devnet", spender: DRAINER });
  });

  it("buys prices through the mandate and records the purchase on the report", async () => {
    const script: ScriptedAnswer[] = [{ match: () => true, answer: '{"protocols":[]}' }];
    const { tools, requestPayment } = fakeTools(script, mandateView());
    const report = await runMonitor(baseCfg(tools, new RunLog("m", false)));
    expect(requestPayment).toHaveBeenCalledWith(expect.objectContaining({ service: "feed.agentrail.eth" }));
    expect(report.purchase?.status).toBe("paid");
    expect(report.prices).toMatchObject({ ETH: 3000, USDT: 1 });
  });

  it("is honest when the discovery pass finds nothing: NONE verdict, a note, drills still attempted", async () => {
    const script: ScriptedAnswer[] = [
      { match: (q) => q.includes("Which DeFi protocols"), answer: '{"protocols":[],"tried":["aave-sg","uniswap-sg"]}' },
      { match: () => true, answer: '{"approvals":[],"transfers":[],"balances":[],"tried":["x"]}' },
    ];
    const { tools } = fakeTools(script, mandateView());
    const report = await runMonitor(baseCfg(tools, new RunLog("m", false)));
    expect(report.protocols).toEqual([]);
    expect(report.verdict.severity).toBe("NONE");
    expect(report.notes.join(" ")).toContain("no positions");
  });
});

describe("the drill questions name the wallet and the window, never a hardcoded protocol", () => {
  it("discovery asks which protocols and names several families as candidates, not one answer", () => {
    const q = discoveryQuestion(ALICE, "eip155:1");
    expect(q).toContain(ALICE.toLowerCase());
    expect(q).toContain("Aave");
    expect(q).toContain("Uniswap");
    expect(q).toMatch(/JSON/);
  });

  it("the approvals drill is scoped to the wallet and the time window", () => {
    const q = approvalsQuestion(ALICE, "eip155:1", NOW, 86_400);
    expect(q).toContain(ALICE.toLowerCase());
    expect(q).toContain(String(NOW));
    expect(q).toContain(String(NOW - 86_400));
  });
});
