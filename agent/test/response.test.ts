import { AdapterRegistry, CHAINS, SPL_TOKEN_PROGRAM, SolanaAdapter, type SolanaGateClient, type SolanaMandateState } from "@agentrail/sdk";
import { describe, expect, it, vi } from "vitest";

import { respond, type AlertFn } from "../src/response.ts";
import { correlate, r1UnknownOrUnlimitedApproval, type ApprovalEvent, type Finding, type Verdict } from "../src/rules/index.ts";
import { createTools, type ToolsConfig } from "../src/tools.ts";
import { RunLog } from "../src/transcript.ts";

const NODE = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";
const AGENT = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const OWNER = "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb";
const OWNER_ATA = "AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9";
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const DRAINER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NOW = 1_800_000_000;
const slot = (tag: number) => "0x" + Buffer.from([tag, 0, 0, 0, 0, 0, 0, 0]).toString("hex");

/** The mandate as issued by demo:devnet (Transfer only) or after the owner lists Revoke as well. */
const mandate = (tags: number[]): SolanaMandateState => ({
  active: true,
  expiry: 4_000_000_000n,
  agent: AGENT,
  permissions: [{ key: SPL_TOKEN_PROGRAM, spendLimit: 2_000_000n, perTxLimit: 1_000_000n, spendTotal: 0n, discriminators: tags.map(slot), discriminatorSize: 1 }],
});

function harness(tags: number[]) {
  const client = {
    readMandate: vi.fn(async () => mandate(tags)),
    destinationTokenAccount: vi.fn(async () => OWNER_ATA),
    buildExecutePayment: vi.fn(async () => new Uint8Array([1])),
    buildVerifiedInstruction: vi.fn(async () => new Uint8Array([2])),
    send: vi.fn(async () => "5igPaid"),
    land: vi.fn(async () => ({ signature: "5igRevoke", failed: false, errorLine: "", errorCode: null, errorName: null })),
    now: vi.fn(async () => BigInt(NOW)),
  };
  const log = new RunLog("response", false);
  const cfg: ToolsConfig = {
    agentName: "databot.agentrail.eth",
    ensNode: NODE,
    readText: async () => null,
    explore: vi.fn(async () => {
      throw new Error("the response never explores");
    }),
    history: vi.fn(async () => {
      throw new Error("the response never queries history");
    }),
    registry: new AdapterRegistry().register(CHAINS.SOLANA_DEVNET, () => new SolanaAdapter({ agent: AGENT, client: client as SolanaGateClient })),
    mandates: { [CHAINS.SOLANA_DEVNET]: { chain: CHAINS.SOLANA_DEVNET, id: PDA } },
    allowed: [],
    solana: { client: client as SolanaGateClient, agent: AGENT, mandate: PDA, owner: OWNER, ownerTokenAccount: OWNER_ATA, asset: USDC },
    log,
  };
  const tools = createTools(cfg);
  const requestAction = vi.spyOn(tools, "requestAction");
  const alert: AlertFn = vi.fn(async () => ({ channel: "hcs:0.0.10440940", id: "0.0.4863756@1.2", explorer: "https://hashscan.io/testnet/topic/0.0.10440940" }));
  return { tools, client, log, alert, requestAction };
}

/** The demo scenario: Alice's delegated USDC account was re-delegated to an unknown key, unlimited, 20 minutes ago. */
const drainerApproval: ApprovalEvent = {
  chain: "solana:devnet",
  token: OWNER_ATA,
  tokenSymbol: "USDC",
  owner: OWNER,
  spender: DRAINER,
  amount: ((1n << 64n) - 1n).toString(),
  timestamp: NOW - 20 * 60,
  spenderHistory: { txCount: 0, known: false },
  source: "getMyMandate.delegation",
};

const criticalVerdict = (): Verdict => correlate(OWNER, r1UnknownOrUnlimitedApproval([drainerApproval], { now: NOW, knownSpenders: new Set([PDA.toLowerCase()]) }), { protocols: ["Aave V3"] });

const verdictOf = (severity: Verdict["severity"], finding?: Finding): Verdict => ({
  subject: OWNER,
  severity,
  findings: finding ? [finding] : [],
  reasoning: `${severity} for the test`,
  recommendedAction: finding?.recommendedAction ?? { kind: "log", message: "nothing" },
  at: new Date(NOW * 1000).toISOString(),
});

describe("graded response", () => {
  it("CRITICAL with permission: alerts, requests Revoke through the gate, and the chain lands it", async () => {
    const h = harness([3, 5]);
    const verdict = criticalVerdict();
    expect(verdict.severity).toBe("CRITICAL");
    expect(verdict.recommendedAction).toMatchObject({ kind: "revokeApproval", chain: "solana:devnet", spender: DRAINER });
    const r = await respond(verdict, { tools: h.tools, alert: h.alert, log: h.log });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.requestAction).toHaveBeenCalledWith({ instruction: "revoke", reason: `clear the delegation to ${DRAINER} on ${OWNER}` });
    expect(h.client.buildVerifiedInstruction).toHaveBeenCalledTimes(1);
    expect(h.client.land).toHaveBeenCalledTimes(1);
    expect(r.protective).toMatchObject({ defended: true, outcome: { status: "executed", signature: "5igRevoke", tag: 5 } });
    expect(r.warning).toBeUndefined();
    expect(r.alert?.channel).toBe("hcs:0.0.10440940");
  });

  it("CRITICAL without permission: alerts, the gate refuses, nothing is built or sent, the agent warns", async () => {
    const h = harness([3]);
    const r = await respond(criticalVerdict(), { tools: h.tools, alert: h.alert, log: h.log });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.requestAction).toHaveBeenCalledTimes(1);
    expect(h.client.buildVerifiedInstruction).not.toHaveBeenCalled();
    expect(h.client.land).not.toHaveBeenCalled();
    expect(h.client.send).not.toHaveBeenCalled();
    expect(r.protective).toMatchObject({ defended: false, outcome: { status: "refused", reason: "InstructionNotAllowed", sent: false } });
    expect(r.warning).toMatch(/does not permit revoke \(InstructionNotAllowed\)/);
    expect(h.log.of("refusal")).toHaveLength(1);
  });

  it("CRITICAL on a chain with no delegation: warn only, the gate is never asked", async () => {
    const h = harness([3, 5]);
    const finding = r1UnknownOrUnlimitedApproval([{ ...drainerApproval, chain: "eip155:1", token: "0xdac17f958d2ee523a2206206994597c13d831ec7", owner: "0xalice" }], { now: NOW })[0];
    const r = await respond(verdictOf("CRITICAL", finding), { tools: h.tools, alert: h.alert, log: h.log });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.requestAction).not.toHaveBeenCalled();
    expect(r.warning).toMatch(/holds no delegation/);
  });

  it("HIGH alerts and does not act; MEDIUM logs and does not alert", async () => {
    const h = harness([3, 5]);
    const high = await respond(verdictOf("HIGH"), { tools: h.tools, alert: h.alert, log: h.log });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.requestAction).not.toHaveBeenCalled();
    expect(high.alert?.id).toBe("0.0.4863756@1.2");
    const medium = await respond(verdictOf("MEDIUM"), { tools: h.tools, alert: h.alert, log: h.log });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(medium.alert).toBeUndefined();
    expect(h.log.of("decision").map((e) => e.title)).toEqual(["HIGH: alert the owner, do not act", "MEDIUM: logged for the owner, no alert, no action"]);
  });

  it("without an alert channel the log is the channel", async () => {
    const h = harness([3, 5]);
    await respond(verdictOf("HIGH"), { tools: h.tools, log: h.log });
    expect(h.log.of("alert")[0].title).toBe("HIGH: owner alerted (log channel)");
  });
});
