import type { HistoryResult } from "@agentrail/query/src/history.ts";
import { AdapterRegistry, CHAINS, SPL_TOKEN_PROGRAM, SolanaAdapter, X402_NETWORK, type ChainId, type EnsTextReader, type PaymentAdapter, type SolanaGateClient, type SolanaMandateState } from "@agentrail/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ExploreResult } from "../src/explore.ts";
import { buildTokenSibling, callTool, createTools, requestFor, type ToolsConfig } from "../src/tools.ts";
import { RunLog } from "../src/transcript.ts";

const NODE = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";
const AGENT = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const OWNER = "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb";
const OWNER_ATA = "AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9";
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const SHOP_WALLET = "GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj";
const SHOP_ATA = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";
const ATTACKER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ATTACKER_ATA = "3h1zGmCwsRJnVk5BuRNMXVPMp7WhMPr4vdtx1jvJjqhq";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SELLER = "0.0.10440535";
const slot = (tag: number) => "0x" + Buffer.from([tag, 0, 0, 0, 0, 0, 0, 0]).toString("hex");

const records: Record<string, Record<string, string>> = {
  "feed.agentrail.eth": { "rail.endpoint": "https://feed.test", "rail.chain": "hedera:testnet", "rail.price": "10000", "rail.token": "0.0.429274", "rail.scheme": "x402", description: "prices" },
  "rogue.agentrail.eth": { "rail.endpoint": "https://feed.test/demo/unlisted/price/SOL,HBAR?payTo=0.0.98", "rail.chain": "hedera:testnet", "rail.price": "10000", "rail.token": "0.0.429274", "rail.scheme": "x402" },
  "graph.agentrail.eth": { "rail.endpoint": "https://gateway.test/api/x402/subgraphs/id/abc", "rail.chain": "eip155:84532", "rail.price": "42", "rail.token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "rail.scheme": "x402" },
};
const readText: EnsTextReader = async (name, key) => records[name]?.[key] ?? null;

/** A service-settled tail (Hedera-shaped) that records what was called and counts paid requests. */
function fakeServiceAdapter(chain: ChainId, counter: { paid: number }) {
  const calls = { quote: 0, authorize: 0, settle: 0 };
  const adapter: PaymentAdapter = {
    chain,
    async quote(service) {
      calls.quote++;
      const payTo = service.url.includes("payTo=0.0.98") ? "0.0.98" : SELLER;
      return { chain, service, amount: 20000n, asset: "0.0.429274", payTo, requirements: { scheme: "exact", network: X402_NETWORK[chain], amount: "20000", payTo, asset: "0.0.429274", resource: service.url } };
    },
    async authorize(mandate, quote) {
      calls.authorize++;
      return { chain, quote, mandate, gate: { kind: "evm-authorize", txHash: "0xgate" }, paymentHeader: "AAAA" };
    },
    async settle() {
      calls.settle++;
      counter.paid++;
      return { chain, transactionId: "0.0.7162784@1.2", explorer: "https://hashscan.io/testnet/transaction/0.0.7162784-1-2", response: { data: [{ symbol: "SOL", price: 100 }], payment: { transactionId: "0.0.7162784@1.2" } } };
    },
  };
  return { adapter, calls };
}

function mandateState(tags: number[], over: Partial<SolanaMandateState> = {}): SolanaMandateState {
  return {
    active: true,
    expiry: 4_000_000_000n,
    agent: AGENT,
    permissions: [
      { key: SHOP_ATA, spendLimit: 5_000_000n, perTxLimit: 2_000_000n, spendTotal: 4_500_000n, discriminators: [], discriminatorSize: 1 },
      { key: SPL_TOKEN_PROGRAM, spendLimit: 2_000_000n, perTxLimit: 1_000_000n, spendTotal: 500_000n, discriminators: tags.map(slot), discriminatorSize: 1 },
    ],
    ...over,
  };
}

function fakeSolanaClient(state: SolanaMandateState | null, landFailure?: { errorName: string; errorCode: number }) {
  const client = {
    readMandate: vi.fn(async () => state),
    destinationTokenAccount: vi.fn(async (payTo: string) => (payTo === SHOP_WALLET ? SHOP_ATA : ATTACKER_ATA)),
    buildExecutePayment: vi.fn(async () => new Uint8Array([1])),
    buildVerifiedInstruction: vi.fn(async () => new Uint8Array([2])),
    send: vi.fn(async () => "5igPaid"),
    land: vi.fn(async () => (landFailure ? { signature: "5igReverted", failed: true, errorLine: `Error Code: ${landFailure.errorName}. Error Number: ${landFailure.errorCode}.`, ...landFailure } : { signature: "5igLanded", failed: false, errorLine: "", errorCode: null, errorName: null })),
    now: vi.fn(async () => 1_800_000_000n),
  };
  return client as SolanaGateClient & typeof client;
}

const historyResult = (): HistoryResult => ({
  ensNode: NODE,
  mandates: [
    {
      id: `${NODE}:base`, chain: "base", ensNode: NODE, ensName: null, owner: "0xaa", agent: "0x6f", expiry: "1791542976", active: true,
      permissions: [{ id: "p1", target: "0x3016", instructions: [], perTxLimit: "100", totalLimit: "500", spentTotal: "126", source: "onchain", targetChain: null }],
      actions: [{ id: "a1", kind: "authorize", timestamp: "1", target: "0x3016", amount: "42", allowed: true, blockReason: null, errorCode: null, txHash: "0x1" }],
    },
    {
      id: `${NODE}:solana`, chain: "solana", ensNode: NODE, ensName: null, owner: OWNER, agent: AGENT, expiry: "1791542976", active: true,
      permissions: [
        { id: "p2", target: SHOP_ATA, instructions: [], perTxLimit: "2000000", totalLimit: "5000000", spentTotal: "4500000", source: "onchain", targetChain: "solana:devnet" },
        { id: "p3", target: SPL_TOKEN_PROGRAM, instructions: [slot(3)], perTxLimit: "1000000", totalLimit: "2000000", spentTotal: "500000", source: "onchain", targetChain: "solana:devnet" },
      ],
      actions: [
        { id: "s1", kind: "execute_payment", timestamp: "1", target: SHOP_ATA, amount: "1500000", allowed: true, blockReason: null, errorCode: null, txHash: "s1" },
        { id: "s2", kind: "execute_payment", timestamp: "2", target: SHOP_ATA, amount: "2500000", allowed: false, blockReason: "OVER_BUDGET", errorCode: 6007, txHash: "s2" },
        { id: "s3", kind: "verify", timestamp: "3", target: SPL_TOKEN_PROGRAM, amount: "0", allowed: false, blockReason: "NOT_PERMITTED", errorCode: 6006, txHash: "s3" },
      ],
    },
  ],
  sources: [
    { chain: "sepolia", url: "https://studio/sepolia", mandates: 0, actions: 0 },
    { chain: "base", url: "https://studio/base", mandates: 1, actions: 1 },
    { chain: "solana", url: "substreams:devnet", mandates: 1, actions: 3 },
  ],
});

function setup(opts: { tags?: number[]; state?: SolanaMandateState | null; proveOnChain?: boolean; landFailure?: { errorName: string; errorCode: number }; mandates?: ToolsConfig["mandates"] } = {}) {
  const counter = { paid: 0 };
  const hedera = fakeServiceAdapter(CHAINS.HEDERA_TESTNET, counter);
  const state = opts.state === undefined ? mandateState(opts.tags ?? [3]) : opts.state;
  const client = fakeSolanaClient(state, opts.landFailure);
  const registry = new AdapterRegistry().register(CHAINS.HEDERA_TESTNET, () => hedera.adapter).register(CHAINS.SOLANA_DEVNET, () => new SolanaAdapter({ agent: AGENT, client }));
  const explore = vi.fn(async (question: string): Promise<ExploreResult> => ({ question, answer: `{"protocols":[{"name":"Aave V2","subgraphId":"C2zn"}]}`, model: "fake", steps: [{ tool: "search_subgraphs_by_keyword", input: { keyword: "aave" }, output: "{...}" }] }));
  const history = vi.fn(async () => historyResult());
  const log = new RunLog("test", false);
  const cfg: ToolsConfig = {
    agentName: "databot.agentrail.eth",
    ensNode: NODE,
    readText,
    explore,
    history,
    registry,
    mandates: opts.mandates ?? { [CHAINS.HEDERA_TESTNET]: { chain: CHAINS.HEDERA_TESTNET, id: "0xmandate" }, [CHAINS.SOLANA_DEVNET]: { chain: CHAINS.SOLANA_DEVNET, id: PDA } },
    allowed: [
      { chain: "hedera:testnet", target: SELLER, perTx: "30000", total: "50000" },
      { chain: "solana:devnet", target: SHOP_ATA, perTx: "2000000", total: "5000000", mint: USDC },
      { chain: "eip155:84532", target: "0x301672eEf23F0e5f165cfba26762702F20A74430", perTx: "100", total: "500" },
    ],
    solana: { client, agent: AGENT, mandate: PDA, owner: OWNER, ownerTokenAccount: OWNER_ATA, asset: USDC, readDelegation: async () => ({ delegate: PDA, delegatedAmount: 100_000_000n, balance: 94_000_000n }) },
    paidRequests: () => counter.paid,
    proveOnChain: opts.proveOnChain,
    log,
  };
  return { tools: createTools(cfg), cfg, hedera, client, explore, history, log, counter };
}

describe("discoverService and querySubgraph", () => {
  it("resolves a service from ENS records only", async () => {
    const { tools, log } = setup();
    const s = await tools.discoverService("feed.agentrail.eth");
    expect(s).toMatchObject({ chain: "hedera:testnet", url: "https://feed.test", price: 10000n });
    expect(log.entries[0].title).toBe("discoverService(feed.agentrail.eth)");
    await expect(tools.discoverService("nobody.agentrail.eth")).rejects.toThrow(/rail.endpoint is missing/);
  });

  it("answers questions through the MCP loop and never through the fixed query", async () => {
    const { tools, explore, history, log } = setup();
    const a = await tools.querySubgraph("Which protocols does 0xalice hold positions in?");
    expect(explore).toHaveBeenCalledWith("Which protocols does 0xalice hold positions in?");
    expect(history).not.toHaveBeenCalled();
    expect(a.answer).toContain("Aave V2");
    expect(log.entries.map((e) => e.title)).toEqual(["querySubgraph", "  mcp:search_subgraphs_by_keyword", "querySubgraph answer (fake)"]);
  });
});

describe("getMyMandate: the fixed query, never the MCP", () => {
  it("returns caps, spent, remaining, blocked counts per chain plus the live Solana account", async () => {
    const { tools, history, explore } = setup();
    const v = await tools.getMyMandate();
    expect(history).toHaveBeenCalledWith(NODE);
    expect(explore).not.toHaveBeenCalled();
    expect(v.readVia).toBe("fixed-query");
    expect(v.chains.map((c) => c.chain)).toEqual(["sepolia", "base", "solana"]);
    const sol = v.chains[2];
    expect(sol.actions).toEqual({ total: 3, allowed: 1, blocked: 2, blockedReasons: { "6007": 1, "6006": 1 } });
    expect(sol.permissions[0]).toMatchObject({ target: SHOP_ATA, spent: "4500000", remaining: "500000" });
    expect(sol.permissions[1].instructions).toEqual([slot(3)]);
    expect(v.chains[1].permissions[0].remaining).toBe("374");
    expect(v.solana).toMatchObject({ mandate: PDA, active: true, delegation: { delegate: PDA, delegateIsMandate: true, balance: "94000000" } });
    expect(v.solana?.permissions[1].instructions).toEqual([slot(3)]);
  });
});

describe("requestPayment: the only path to money", () => {
  it("pays a discovered, listed service: discover -> quote -> allow-list -> gate -> settle", async () => {
    const { tools, hedera, counter } = setup();
    const out = await tools.requestPayment({ service: "feed.agentrail.eth", symbols: ["sol", "hbar"] });
    expect(out.status).toBe("paid");
    expect(out).toMatchObject({ chain: "hedera:testnet", payTo: SELLER, amount: "20000", gate: "0xgate", transactionId: "0.0.7162784@1.2", paidRequestsSent: 1 });
    expect(out.data).toEqual([{ symbol: "SOL", price: 100 }]);
    expect(hedera.calls).toEqual({ quote: 1, authorize: 1, settle: 1 });
    expect(counter.paid).toBe(1);
  });

  it("refuses a discovered service whose payee is not on rail.allowed: nothing paid, no gate", async () => {
    const { tools, hedera, log } = setup();
    const out = await tools.requestPayment({ service: "rogue.agentrail.eth" });
    expect(out).toMatchObject({ status: "refused", reason: "NotOnAllowList", refusedBy: "allow-list", payTo: "0.0.98", paidRequestsSent: 0 });
    expect(hedera.calls).toEqual({ quote: 1, authorize: 0, settle: 0 });
    expect(log.of("refusal")).toHaveLength(1);
  });

  it("refuses a service on a chain it holds no mandate for before any request leaves", async () => {
    const { tools, hedera } = setup({ mandates: { [CHAINS.SOLANA_DEVNET]: { chain: CHAINS.SOLANA_DEVNET, id: PDA } } });
    const out = await tools.requestPayment({ service: "feed.agentrail.eth" });
    expect(out).toMatchObject({ status: "refused", reason: "NoMandateOnChain", refusedBy: "no-mandate", paidRequestsSent: 0 });
    expect(hedera.calls.quote).toBe(0);
  });

  it("refuses a direct payment to an unlisted wallet without building or sending anything", async () => {
    const { tools, client } = setup();
    const out = await tools.requestPayment({ chain: "solana:devnet", payTo: ATTACKER, amount: "1000000", reason: "recovery deposit" });
    expect(out).toMatchObject({ status: "refused", reason: "NotOnAllowList", refusedBy: "allow-list", destination: ATTACKER_ATA, paidRequestsSent: 0 });
    expect(out.chainVerdict).toBeUndefined();
    expect(client.buildExecutePayment).not.toHaveBeenCalled();
    expect(client.land).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("with proveOnChain, sends the refused request anyway and records the chain's own refusal", async () => {
    const { tools, client, log } = setup({ proveOnChain: true, landFailure: { errorName: "DestinationNotAllowed", errorCode: 6016 } });
    const out = await tools.requestPayment({ chain: "solana:devnet", payTo: ATTACKER, amount: "1000000" });
    expect(out.status).toBe("refused");
    expect(out.chainVerdict).toMatchObject({ signature: "5igReverted", failed: true, errorName: "DestinationNotAllowed", errorCode: 6016 });
    expect(out.chainVerdict?.explorer).toContain("5igReverted");
    expect(client.buildExecutePayment).toHaveBeenCalledWith(PDA, ATTACKER_ATA, 1_000_000n);
    expect(client.land).toHaveBeenCalledTimes(1);
    expect(log.of("chain")[0].title).toContain("REVERTED");
  });

  it("fails loudly if the chain accepts what the gate refused", async () => {
    const { tools } = setup({ proveOnChain: true });
    await expect(tools.requestPayment({ chain: "solana:devnet", payTo: ATTACKER, amount: "1" })).rejects.toThrow(/chain accepted what the gate refused/);
  });

  it("pays a listed wallet within caps through execute_payment, and refuses over the per-tx cap locally", async () => {
    const { tools, client } = setup();
    const ok = await tools.requestPayment({ chain: "solana:devnet", payTo: SHOP_WALLET, amount: "400000" });
    expect(ok).toMatchObject({ status: "paid", destination: SHOP_ATA, gate: "execute_payment", transactionId: "5igPaid" });
    expect(client.send).toHaveBeenCalledTimes(1);
    const no = await tools.requestPayment({ chain: "solana:devnet", payTo: SHOP_WALLET, amount: "2500000" });
    expect(no).toMatchObject({ status: "refused", reason: "PerTxLimitExceeded", refusedBy: "local-gate" });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.land).not.toHaveBeenCalled();
  });
});

describe("requestAction: the instruction gate", () => {
  it("refuses SetAuthority when the mandate lists Transfer only; nothing is built or sent", async () => {
    const { tools, client, log } = setup({ tags: [3] });
    const out = await tools.requestAction({ instruction: "setAuthority", newAuthority: ATTACKER });
    expect(out).toMatchObject({ status: "refused", reason: "InstructionNotAllowed", refusedBy: "local-gate", tag: 6, program: SPL_TOKEN_PROGRAM, account: OWNER_ATA, sent: false });
    expect(client.buildVerifiedInstruction).not.toHaveBeenCalled();
    expect(client.land).not.toHaveBeenCalled();
    expect(log.of("refusal")[0].title).toContain("InstructionNotAllowed");
  });

  it("with proveOnChain, lands verify + SetAuthority and records REVERTED 6006", async () => {
    const { tools, client } = setup({ tags: [3], proveOnChain: true, landFailure: { errorName: "InstructionNotAllowed", errorCode: 6006 } });
    const out = await tools.requestAction({ instruction: "setAuthority", newAuthority: ATTACKER });
    expect(out.status).toBe("refused");
    expect(out.sent).toBe(true);
    expect(out.chainVerdict).toMatchObject({ failed: true, errorCode: 6006, errorName: "InstructionNotAllowed" });
    expect(client.buildVerifiedInstruction).toHaveBeenCalledTimes(1);
    const sibling = client.buildVerifiedInstruction.mock.calls[0][1];
    expect(sibling.programId).toBe(SPL_TOKEN_PROGRAM);
    expect(sibling.data[0]).toBe(6);
  });

  it("executes Revoke once the owner lists it: verify + Revoke land with a signature", async () => {
    const { tools, client } = setup({ tags: [3, 5] });
    const out = await tools.requestAction({ instruction: "revoke", reason: "clear a drainer delegation" });
    expect(out).toMatchObject({ status: "executed", tag: 5, sent: true, signature: "5igLanded" });
    expect(out.explorer).toContain("5igLanded");
    expect(client.land).toHaveBeenCalledTimes(1);
  });

  it("reports the chain's refusal when the local mirror disagrees with the chain", async () => {
    const { tools } = setup({ tags: [3, 5], landFailure: { errorName: "InstructionNotAllowed", errorCode: 6006 } });
    const out = await tools.requestAction({ instruction: "revoke" });
    expect(out).toMatchObject({ status: "refused", refusedBy: "chain", reason: "InstructionNotAllowed", sent: true, signature: "5igReverted" });
  });

  it("refuses everything when there is no mandate on the chain", async () => {
    const s = setup();
    const tools = createTools({ ...s.cfg, solana: undefined });
    const out = await tools.requestAction({ instruction: "revoke" });
    expect(out).toMatchObject({ status: "refused", reason: "NoMandateOnChain", sent: false });
  });
});

describe("plumbing", () => {
  it("builds the SPL instruction for each action and never a transfer", () => {
    const rail = { owner: OWNER, ownerTokenAccount: OWNER_ATA };
    expect(buildTokenSibling({ instruction: "revoke" }, rail).data).toEqual(new Uint8Array([5]));
    expect(buildTokenSibling({ instruction: "approve", delegate: ATTACKER, amount: "0" }, rail).data[0]).toBe(4);
    expect(buildTokenSibling({ instruction: "setAuthority", newAuthority: ATTACKER }, rail).data[0]).toBe(6);
    expect(buildTokenSibling({ instruction: "closeAccount", destination: ATTACKER }, rail).data).toEqual(new Uint8Array([9]));
    expect(() => buildTokenSibling({ instruction: "transfer" } as never, rail)).toThrow(/unknown instruction/);
    const revoke = buildTokenSibling({ instruction: "revoke" }, rail);
    expect(revoke.keys.map((k) => [k.pubkey, k.isSigner])).toEqual([[OWNER_ATA, false], [OWNER, true]]);
  });

  it("shapes the request per service kind: symbols for the feed, a GraphQL POST for a gateway", async () => {
    const { tools } = setup();
    const feed = await tools.discoverService("feed.agentrail.eth");
    expect(requestFor(feed, { service: feed.name, symbols: ["btc", "eth"] }).url).toBe("https://feed.test/price/BTC,ETH");
    const graph = await tools.discoverService("graph.agentrail.eth");
    const ref = requestFor(graph, { service: graph.name, query: "{ _meta { block { number } } }" });
    expect(ref.request?.method).toBe("POST");
    expect(JSON.parse(ref.request?.body ?? "{}")).toEqual({ query: "{ _meta { block { number } } }" });
  });

  it("dispatches model calls to the typed functions and answers bad input with an error, not a crash", async () => {
    const { tools } = setup();
    const paid = (await callTool(tools, "requestPayment", { service: "feed.agentrail.eth", symbols: ["SOL"] })) as { status: string };
    expect(paid.status).toBe("paid");
    const direct = (await callTool(tools, "requestPayment", { chain: "solana:devnet", payTo: ATTACKER, amount: 1000000 })) as { status: string; reason: string };
    expect(direct).toMatchObject({ status: "refused", reason: "NotOnAllowList" });
    expect(await callTool(tools, "requestPayment", { amount: "1" })).toEqual({ error: "requestPayment needs either service (ENS name) or payTo + amount" });
    expect(await callTool(tools, "nope", {})).toEqual({ error: "unknown tool nope" });
  });
});
