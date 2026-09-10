import { describe, expect, it } from "vitest";

import {
  correlate,
  fromApprovalRows,
  fromMessariAccount,
  fromTransferRows,
  healthFactor,
  r1UnknownOrUnlimitedApproval,
  r2AbnormalOutflow,
  r3LiquidationProximity,
  runRules,
  type ApprovalEvent,
  type Balance,
  type LendingPosition,
  type RiskData,
  type TransferEvent,
} from "../src/rules/index.ts";

const NOW = 1_800_000_000;
const ALICE = "0xA11ce0000000000000000000000000000000A11c";
const DRAINER = "0xbad0000000000000000000000000000000000bad";
const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 router
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const MAX = ((1n << 256n) - 1n).toString();

// ---- R1: fires on the drainer signature, silent on clean approvals --------------------------------

const approval = (over: Partial<ApprovalEvent> = {}): ApprovalEvent => ({ chain: "eip155:1", token: USDT, tokenSymbol: "USDT", owner: ALICE, spender: DRAINER, amount: "1000000", timestamp: NOW - 20 * 60, source: "test", ...over });

describe("R1 unknown-or-unlimited approval (CRITICAL)", () => {
  it("fires on an unlimited approval to a spender with no history, granted in the window", () => {
    const f = r1UnknownOrUnlimitedApproval([approval({ amount: MAX, spenderHistory: { txCount: 0, known: false } })], { now: NOW });
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("CRITICAL");
    expect(f[0].evidence).toMatchObject({ unlimited: true, noHistory: true, spender: DRAINER });
    expect(f[0].recommendedAction).toEqual({ kind: "revokeApproval", chain: "eip155:1", token: USDT, account: ALICE, spender: DRAINER });
  });

  it("fires on unlimited alone, and on no-history alone", () => {
    expect(r1UnknownOrUnlimitedApproval([approval({ amount: MAX, spenderHistory: { known: true, label: "Aave" } })], { now: NOW })).toHaveLength(1);
    expect(r1UnknownOrUnlimitedApproval([approval({ amount: "500", spenderHistory: { txCount: 0 } })], { now: NOW })).toHaveLength(1);
  });

  it("stays silent on clean data: a bounded approval to a known router with history", () => {
    const clean = approval({ spender: ROUTER, amount: "250000", spenderHistory: { txCount: 5_000_000, known: true, label: "Uniswap V2" } });
    expect(r1UnknownOrUnlimitedApproval([clean], { now: NOW })).toEqual([]);
  });

  it("does not fire on a stale approval, a revocation, a known spender, or unknown-but-not-empty history", () => {
    expect(r1UnknownOrUnlimitedApproval([approval({ amount: MAX, timestamp: NOW - 3 * 86_400, spenderHistory: { txCount: 0 } })], { now: NOW })).toEqual([]); // stale
    expect(r1UnknownOrUnlimitedApproval([approval({ amount: "0", spenderHistory: { txCount: 0 } })], { now: NOW })).toEqual([]); // a revoke
    expect(r1UnknownOrUnlimitedApproval([approval({ amount: MAX })], { now: NOW, knownSpenders: new Set([DRAINER.toLowerCase()]) })).toEqual([]); // chosen spender
    expect(r1UnknownOrUnlimitedApproval([approval({ amount: "1000" })], { now: NOW })).toEqual([]); // no history data, bounded: absence is not evidence
  });
});

// ---- R2: fires on a large outflow, silent on a small one ------------------------------------------

const balance = (amount: number): Balance => ({ chain: "eip155:1", token: USDT, tokenSymbol: "USDT", amount, amountUSD: amount, source: "test" });
const transferOut = (amount: number, over: Partial<TransferEvent> = {}): TransferEvent => ({ chain: "eip155:1", token: USDT, tokenSymbol: "USDT", amount, amountUSD: amount, from: ALICE, to: DRAINER, timestamp: NOW - 3600, source: "test", ...over });

describe("R2 abnormal outflow (HIGH)", () => {
  it("fires when more than 20% of a balance left in the window", () => {
    const f = r2AbnormalOutflow([transferOut(300), transferOut(100)], [balance(600)], { now: NOW, wallet: ALICE });
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("HIGH");
    expect(f[0].evidence).toMatchObject({ outflow: 400, balanceStart: 1000, destinations: [DRAINER] });
    expect(f[0].recommendedAction.kind).toBe("alertOwner");
  });

  it("stays silent on a small outflow, a self-transfer, and a stale one", () => {
    expect(r2AbnormalOutflow([transferOut(50)], [balance(950)], { now: NOW, wallet: ALICE })).toEqual([]); // 5%
    expect(r2AbnormalOutflow([transferOut(500, { to: ALICE })], [balance(500)], { now: NOW, wallet: ALICE })).toEqual([]); // self
    expect(r2AbnormalOutflow([transferOut(500, { timestamp: NOW - 2 * 86_400 })], [balance(500)], { now: NOW, wallet: ALICE })).toEqual([]); // stale
  });

  it("makes no claim without a current balance to divide by", () => {
    expect(r2AbnormalOutflow([transferOut(999)], [], { now: NOW, wallet: ALICE })).toEqual([]);
  });
});

// ---- R3: fires below 1.1, silent above -----------------------------------------------------------

const position = (over: Partial<LendingPosition>): LendingPosition => ({ protocol: "Aave V3", chain: "eip155:1", source: "test", ...over });

describe("R3 liquidation proximity (MEDIUM)", () => {
  it("fires on a reported health factor below 1.1", () => {
    const f = r3LiquidationProximity([position({ healthFactor: 1.03, debtUSD: 10_000, collateralUSD: 12_000 })]);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("MEDIUM");
    expect(f[0].recommendedAction.kind).toBe("log");
  });

  it("computes the health factor from collateral, threshold and debt when none is reported", () => {
    expect(healthFactor(position({ collateralUSD: 10_000, liquidationThreshold: 0.8, debtUSD: 8_000 }))).toBeCloseTo(1.0, 5);
    const f = r3LiquidationProximity([position({ collateralUSD: 10_000, liquidationThreshold: 0.8, debtUSD: 8_000 })]);
    expect(f).toHaveLength(1);
  });

  it("stays silent on a healthy position and on one with no debt", () => {
    expect(r3LiquidationProximity([position({ healthFactor: 2.4, debtUSD: 5_000 })])).toEqual([]);
    expect(r3LiquidationProximity([position({ collateralUSD: 10_000, liquidationThreshold: 0.8, debtUSD: 0 })])).toEqual([]);
  });
});

// ---- the engine + the verdict --------------------------------------------------------------------

describe("runRules and correlate", () => {
  const clean: RiskData = {
    wallet: ALICE,
    approvals: [approval({ spender: ROUTER, amount: "250000", spenderHistory: { txCount: 9_000_000, known: true } })],
    transfers: [transferOut(10)],
    balances: [balance(1000)],
    positions: [position({ healthFactor: 3.1, debtUSD: 1000 })],
  };

  it("returns nothing and a NONE verdict on wholly clean data", () => {
    const findings = runRules(clean, { now: NOW });
    expect(findings).toEqual([]);
    const v = correlate(ALICE, findings, { protocols: ["Aave V3", "Uniswap V3"] });
    expect(v.severity).toBe("NONE");
    expect(v.reasoning).toContain("exposed to Aave V3, Uniswap V3");
    expect(v.reasoning).toContain("No rule fired");
  });

  it("ranks a mixed bag CRITICAL-first and the verdict takes the CRITICAL action", () => {
    const data: RiskData = {
      wallet: ALICE,
      approvals: [approval({ amount: MAX, spenderHistory: { txCount: 0, known: false } })],
      transfers: [transferOut(400)],
      balances: [balance(600)],
      positions: [position({ healthFactor: 1.05, debtUSD: 9000, collateralUSD: 10000 })],
    };
    const findings = runRules(data, { now: NOW });
    expect(findings.map((f) => f.rule)).toEqual(["R1", "R2", "R3"]);
    const v = correlate(ALICE, findings);
    expect(v.severity).toBe("CRITICAL");
    expect(v.recommendedAction).toMatchObject({ kind: "revokeApproval", spender: DRAINER });
    expect(v.reasoning).toContain("CRITICAL regardless");
  });
});

// ---- adapters from raw subgraph shapes -----------------------------------------------------------

describe("adapters over real subgraph shapes", () => {
  it("derives collateral, debt and a weighted threshold from a Messari account", () => {
    const p = fromMessariAccount(
      {
        id: ALICE,
        positions: [
          { side: "COLLATERAL", balance: "10000000000", market: { name: "WETH", inputToken: { symbol: "WETH", decimals: 6 }, liquidationThreshold: "82.5", inputTokenPriceUSD: "1" } },
          { side: "BORROWER", balance: "9000000000", market: { name: "USDC", inputToken: { symbol: "USDC", decimals: 6 }, inputTokenPriceUSD: "1" } },
        ],
      },
      "Aave V3",
      "eip155:1",
      "fixture",
    );
    expect(p.collateralUSD).toBeCloseTo(10_000, 0);
    expect(p.debtUSD).toBeCloseTo(9_000, 0);
    expect(p.liquidationThreshold).toBeCloseTo(0.825, 3);
    expect(healthFactor(p)).toBeCloseTo((10_000 * 0.825) / 9_000, 3);
    expect(r3LiquidationProximity([p])).toHaveLength(1);
  });

  it("reads approval and transfer rows into rule inputs", () => {
    const approvals = fromApprovalRows([{ owner: ALICE, spender: DRAINER, value: MAX, blockTimestamp: NOW - 60, token: { id: USDT, symbol: "USDT" } }], "eip155:1", "fixture");
    expect(approvals[0]).toMatchObject({ owner: ALICE, spender: DRAINER, amount: MAX, tokenSymbol: "USDT" });
    const transfers = fromTransferRows([{ from: ALICE, to: DRAINER, value: "400000000", blockTimestamp: NOW - 60, token: { id: USDT, symbol: "USDT", decimals: 6 } }], "eip155:1", "fixture");
    expect(transfers[0]).toMatchObject({ amount: 400, to: DRAINER });
  });
});
