import type { HistoryResult } from "@agentrail/query/src/history.ts";
import type { SolanaMandateState } from "@agentrail/sdk/src/tails/solana.ts";
import { describe, expect, it, vi } from "vitest";

import { checkPermission, getHistory, getMandate, listServices, type Deps } from "../src/tools.ts";

const NODE = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";
const AGENT_SOL = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const SHOP_WALLET = "GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj";
const SHOP_ATA = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";
const ATTACKER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ATTACKER_ATA = "5K3tmjKHJcLujL7SLZcEjutEZnrzMruUXTzQV6z5cQT6";
const HEDERA_AGENT = "0x0F072339a79E72a78A0535BB9132228c8B8b1fF0";
const SELLER = "0.0.10440535";

const records: Record<string, Record<string, string>> = {
  "databot.agentrail.eth": {
    "rail.version": "1",
    "rail.agent.solana": AGENT_SOL,
    "rail.agent.hedera": HEDERA_AGENT,
    "rail.mandate.pda": PDA,
    "rail.allowed": JSON.stringify([
      { chain: "solana:devnet", target: SHOP_ATA, perTx: "2000000", total: "5000000" },
      { chain: "hedera:testnet", target: SELLER, perTx: "30000", total: "50000" },
    ]),
  },
  "feed.agentrail.eth": { "rail.endpoint": "https://feed.test", "rail.chain": "hedera:testnet", "rail.price": "10000", "rail.token": "0.0.429274", "rail.scheme": "x402", description: "prices" },
  "rogue.agentrail.eth": { "rail.endpoint": "https://feed.test/demo/unlisted/price/SOL?payTo=0.0.98", "rail.chain": "hedera:testnet", "rail.price": "10000", "rail.token": "0.0.429274", "rail.scheme": "x402" },
};

const solanaState: SolanaMandateState = { active: true, expiry: 4_000_000_000n, agent: AGENT_SOL, permissions: [{ key: SHOP_ATA, spendLimit: 5_000_000n, perTxLimit: 2_000_000n, spendTotal: 4_500_000n }] };

function fakeDeps(over: Partial<Deps> = {}) {
  const deps: Deps = {
    agentName: "databot.agentrail.eth",
    serviceNames: ["feed.agentrail.eth", "rogue.agentrail.eth"],
    owner: { solana: "55FJ" },
    readText: vi.fn(async (name: string, key: string) => records[name]?.[key] ?? null),
    now: () => 1_800_000_000n,
    history: vi.fn(async (ensNode: string): Promise<HistoryResult> => ({
      ensNode,
      mandates: [{ id: `${NODE}:solana`, chain: "solana", ensNode, ensName: null, owner: "55FJ", agent: AGENT_SOL, expiry: "1", active: true, permissions: [], actions: [
        { id: "a", kind: "execute_payment", timestamp: "10", target: SHOP_ATA, amount: "1500000", allowed: true, blockReason: null, errorCode: null, txHash: "sigA" },
        { id: "b", kind: "execute_payment", timestamp: "20", target: ATTACKER_ATA, amount: "1000000", allowed: false, blockReason: "NOT_PERMITTED", errorCode: 6016, txHash: "sigB" },
        { id: "c", kind: "verify", timestamp: "30", target: "Tokenkeg", amount: "0", allowed: false, blockReason: "NOT_PERMITTED", errorCode: 6006, txHash: "sigC" },
      ] }],
      sources: [{ chain: "sepolia", url: "s", mandates: 0, actions: 0 }, { chain: "base", url: "b", mandates: 0, actions: 0 }, { chain: "solana", url: "substreams", mandates: 1, actions: 3 }],
    })),
    readSolana: vi.fn(async () => solanaState),
    solanaDestination: (payTo: string) => (payTo === SHOP_WALLET ? SHOP_ATA : ATTACKER_ATA),
    readEvm: vi.fn(async (chain, agent) => ({ id: "0xmandate", exists: true, active: true, expiry: 1_900_000_000, agent, permissions: [{ target: "0x00000000000000000000000000000000009f4f57", perTx: "30000", total: "50000", spent: "20000" }] })),
    evmCheck: vi.fn(async (_chain, _id, _agent, _destination, amount: bigint) => (amount > 30000n ? "PerTxLimitExceeded" : "ok")),
    ...over,
  };
  return deps;
}

describe("get_mandate", () => {
  it("returns the records, the allow-list and the live mandate per chain for an agent", async () => {
    const deps = fakeDeps();
    const m = await getMandate(deps, " Databot.AgentRail.eth ");
    expect(m.kind).toBe("agent");
    expect(m.ensNode).toBe(NODE);
    expect(m.allowed).toHaveLength(2);
    expect(m.live.solana).toMatchObject({ pda: PDA, active: true, agent: AGENT_SOL });
    expect(m.live.solana?.permissions[0]).toMatchObject({ key: SHOP_ATA, spendTotal: "4500000" });
    expect(m.live.hedera).toMatchObject({ id: "0xmandate", active: true });
    expect(m.live.base).toBeUndefined(); // no rail.agent.base on this name
    expect(m.readOnly).toBe(true);
  });

  it("classifies a service and an unknown name without reading any chain", async () => {
    const deps = fakeDeps();
    expect((await getMandate(deps, "feed.agentrail.eth")).kind).toBe("service");
    expect((await getMandate(deps, "vitalik.eth")).kind).toBe("unknown");
    expect(deps.readSolana).not.toHaveBeenCalled();
    expect(deps.readEvm).not.toHaveBeenCalled();
  });
});

describe("check_permission", () => {
  it("permits a listed Solana payee within caps, through the allow-list and the local gate mirror", async () => {
    const r = await checkPermission(fakeDeps(), { name: "databot.agentrail.eth", chain: "solana:devnet", payee: SHOP_WALLET, amount: "400000" });
    expect(r.allowed).toBe(true);
    expect(r.checks.map((c) => [c.gate.split(" ")[0], c.ok])).toEqual([["allow-list", true], ["solana-local-gate", true]]);
    expect(r.note).toMatch(/nothing was signed/);
  });

  it("refuses an unlisted payee at the allow-list, before any chain is read", async () => {
    const deps = fakeDeps();
    const r = await checkPermission(deps, { name: "databot.agentrail.eth", chain: "solana:devnet", payee: ATTACKER, amount: "1000000" });
    expect(r.allowed).toBe(false);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ gate: "allow-list", ok: false });
    expect(r.checks[0].detail).toMatch(/not on the mandate's rail.allowed list/);
    expect(deps.readSolana).not.toHaveBeenCalled();
  });

  it("refuses over the cap with the program's own reason", async () => {
    const over = await checkPermission(fakeDeps(), { name: "databot.agentrail.eth", chain: "solana:devnet", payee: SHOP_WALLET, amount: "2500000" });
    expect(over.allowed).toBe(false);
    expect(over.checks[1].detail).toBe("PerTxLimitExceeded");
    const lifetime = await checkPermission(fakeDeps(), { name: "databot.agentrail.eth", chain: "solana:devnet", payee: SHOP_WALLET, amount: "600000" });
    expect(lifetime.checks[1].detail).toBe("SpendLimitExceeded"); // 4.5M spent + 0.6M > 5M
  });

  it("checks Hedera through EvmMandate.check with the account id turned into its long-zero address", async () => {
    const deps = fakeDeps();
    const ok = await checkPermission(deps, { name: "databot.agentrail.eth", chain: "hedera:testnet", payee: SELLER, amount: "20000" });
    expect(ok.allowed).toBe(true);
    expect(deps.evmCheck).toHaveBeenCalledWith("hedera", "0xmandate", HEDERA_AGENT, "0x00000000000000000000000000000000009f4f57", 20000n);
    const no = await checkPermission(deps, { name: "databot.agentrail.eth", chain: "hedera:testnet", payee: SELLER, amount: "40000" });
    expect(no.allowed).toBe(false);
    expect(no.checks[1].detail).toBe("PerTxLimitExceeded");
  });

  it("says plainly when the name is not an agent", async () => {
    const r = await checkPermission(fakeDeps(), { name: "vitalik.eth", chain: "solana:devnet", payee: SHOP_WALLET, amount: "1" });
    expect(r.allowed).toBe(false);
    expect(r.checks[0].detail).toMatch(/not an AgentRail agent/);
  });
});

describe("list_services", () => {
  it("resolves the directory from ENS and says which payees the agent may pay on each chain", async () => {
    const { agent, services } = await listServices(fakeDeps());
    expect(agent).toBe("databot.agentrail.eth");
    expect(services.map((s) => s.name)).toEqual(["feed.agentrail.eth", "rogue.agentrail.eth"]);
    expect(services[0]).toMatchObject({ chain: "hedera:testnet", url: "https://feed.test", price: "10000", scheme: "x402", allowedPayees: [SELLER] });
    expect(services[1].url).toContain("payTo=0.0.98");
  });

  it("reports a name that does not resolve as a service instead of throwing", async () => {
    const { services } = await listServices(fakeDeps(), ["vitalik.eth"]);
    expect(services[0].error).toMatch(/rail.endpoint is missing/);
  });
});

describe("get_history", () => {
  it("runs the fixed query and summarises, newest first, with the blocked-only view", async () => {
    const deps = fakeDeps();
    const all = await getHistory(deps, { name: "databot.agentrail.eth" });
    expect(deps.history).toHaveBeenCalledWith(NODE);
    expect(all.summary).toEqual({ actions: 3, allowed: 1, blocked: 2, blockedByCode: { "6016": 1, "6006": 1 } });
    expect(all.rows.map((r) => r.txHash)).toEqual(["sigC", "sigB", "sigA"]);
    const blocked = await getHistory(deps, { ensNode: NODE, blockedOnly: true, limit: 1 });
    expect(blocked.rows).toHaveLength(1);
    expect(blocked.rows[0].errorCode).toBe(6006);
    expect(blocked.truncated).toBe(true);
  });
});
