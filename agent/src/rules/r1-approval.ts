/**
 * R1 — the demo rule. An approval granted inside the window to a spender with no history, or an
 * approval for an unlimited amount. This is the drainer signature: the victim signs one approval on
 * a phishing page, and the drainer empties the account in a later, separate transaction. CRITICAL,
 * because the loss is then one transaction away and needs no further mistake from the victim.
 */
import type { ApprovalEvent, Finding } from "./types.ts";

export const UINT256_MAX = (1n << 256n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;
/** Treat anything within this of the max as "unlimited"; wallets often approve max-1. */
const UNLIMITED_FLOOR = UINT256_MAX - (1n << 128n);

export interface R1Options {
  /** unix seconds */
  now: number;
  /** Only approvals granted inside this window count. Default 24 h. */
  windowSec?: number;
  /** Spenders the owner chose on purpose (lower-cased): the mandate PDA, a known router. */
  knownSpenders?: Set<string>;
}

function toBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/** An amount at or near the type maximum. */
export function isUnlimited(a: ApprovalEvent): boolean {
  if (a.unlimited) return true;
  const v = toBigInt(a.amount);
  if (v === null) return false;
  return v === U64_MAX || v >= UNLIMITED_FLOOR;
}

/**
 * Evidence of NO history: the spender has made zero transactions, or was first seen inside the
 * window. "Unknown" (no data at all) is deliberately not "no history" — the rule does not fire on
 * absence of information, only on evidence of a fresh or empty spender. A recognised protocol is
 * never no-history.
 */
export function hasNoHistory(a: ApprovalEvent, now: number, windowSec: number): boolean {
  const h = a.spenderHistory;
  if (!h) return false;
  if (h.known === true) return false;
  if (h.txCount === 0) return true;
  if (typeof h.firstSeen === "number" && h.firstSeen >= now - windowSec) return true;
  return false;
}

export function r1UnknownOrUnlimitedApproval(approvals: ApprovalEvent[], opts: R1Options): Finding[] {
  const windowSec = opts.windowSec ?? 86_400;
  const known = opts.knownSpenders ?? new Set<string>();
  const findings: Finding[] = [];
  for (const a of approvals) {
    if (a.timestamp < opts.now - windowSec) continue; // not fresh
    if (toBigInt(a.amount) === 0n) continue; // a revocation, not a grant
    if (known.has(a.spender.toLowerCase())) continue; // a spender the owner chose
    const unlimited = isUnlimited(a);
    const noHistory = hasNoHistory(a, opts.now, windowSec);
    if (!unlimited && !noHistory) continue;
    const reasons = [unlimited ? "unlimited amount" : null, noHistory ? "spender with no on-chain history" : null].filter(Boolean).join(" and ");
    const ageMin = Math.max(0, Math.round((opts.now - a.timestamp) / 60));
    findings.push({
      rule: "R1",
      severity: "CRITICAL",
      title: `approval from ${a.owner} to ${a.spender} on ${a.tokenSymbol ?? a.token} (${a.chain}): ${reasons}, granted ${ageMin} min ago`,
      evidence: {
        chain: a.chain,
        token: a.token,
        tokenSymbol: a.tokenSymbol ?? null,
        owner: a.owner,
        spender: a.spender,
        amount: a.amount,
        unlimited,
        noHistory,
        spenderHistory: a.spenderHistory ?? null,
        grantedAt: a.timestamp,
        ageMinutes: ageMin,
        source: a.source,
      },
      recommendedAction: { kind: "revokeApproval", chain: a.chain, token: a.token, account: a.owner, spender: a.spender },
    });
  }
  return findings;
}
