/**
 * R3 — liquidation proximity. A lending position whose health factor has fallen below 1.1. Not
 * theft, but money about to be lost to a liquidation penalty. MEDIUM: log it and name the fix; the
 * owner decides whether to add collateral or repay.
 */
import type { Finding, LendingPosition } from "./types.ts";

export interface R3Options {
  /** Default 1.1. */
  threshold?: number;
}

/**
 * The source's health factor, or collateral x liquidation-threshold / debt when the source gives
 * the parts instead. null when neither is available, or when there is no debt (nothing to liquidate).
 */
export function healthFactor(p: LendingPosition): number | null {
  if (typeof p.healthFactor === "number" && Number.isFinite(p.healthFactor)) return p.healthFactor;
  if (typeof p.collateralUSD === "number" && typeof p.debtUSD === "number" && typeof p.liquidationThreshold === "number") {
    if (p.debtUSD <= 0) return null;
    return (p.collateralUSD * p.liquidationThreshold) / p.debtUSD;
  }
  return null;
}

export function r3LiquidationProximity(positions: LendingPosition[], opts: R3Options = {}): Finding[] {
  const threshold = opts.threshold ?? 1.1;
  const findings: Finding[] = [];
  for (const p of positions) {
    if (typeof p.debtUSD === "number" && p.debtUSD <= 0) continue; // no debt, no liquidation
    const hf = healthFactor(p);
    if (hf === null || hf >= threshold) continue;
    const debt = typeof p.debtUSD === "number" ? Math.round(p.debtUSD) : null;
    const collateral = typeof p.collateralUSD === "number" ? Math.round(p.collateralUSD) : null;
    findings.push({
      rule: "R3",
      severity: "MEDIUM",
      title: `${p.protocol} (${p.chain}) health factor ${hf.toFixed(3)} is below ${threshold}${debt !== null ? `: ${debt} USD of debt against ${collateral ?? 0} USD of collateral` : ""}`,
      evidence: { protocol: p.protocol, chain: p.chain, healthFactor: hf, threshold, collateralUSD: collateral, debtUSD: debt, liquidationThreshold: p.liquidationThreshold ?? null, source: p.source },
      recommendedAction: { kind: "log", message: `repay part of the ${p.protocol} debt or add collateral before the health factor reaches 1.0` },
    });
  }
  return findings;
}
