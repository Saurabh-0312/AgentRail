/**
 * R2 — abnormal outflow. More than a fifth of a token's balance left the account inside the window.
 * Either theft already under way, or a move large enough that the owner must hear about it. HIGH:
 * the agent alerts, it does not try to act — the funds are already leaving and a protective write
 * would not catch them.
 */
import type { Balance, Finding, TransferEvent } from "./types.ts";

export interface R2Options {
  /** unix seconds */
  now: number;
  wallet: string;
  windowSec?: number;
  /** Fraction of the starting balance that counts as abnormal. Default 0.2. */
  threshold?: number;
}

export function r2AbnormalOutflow(transfers: TransferEvent[], balances: Balance[], opts: R2Options): Finding[] {
  const windowSec = opts.windowSec ?? 86_400;
  const threshold = opts.threshold ?? 0.2;
  const wallet = opts.wallet.toLowerCase();
  const key = (chain: string, token: string) => `${chain}:${token.toLowerCase()}`;

  // Sum outflow per token: transfers leaving the wallet (not self-transfers) inside the window.
  const out = new Map<string, { amount: number; amountUSD: number; hasUSD: boolean; transfers: TransferEvent[] }>();
  for (const t of transfers) {
    if (t.from.toLowerCase() !== wallet) continue;
    if (t.to.toLowerCase() === wallet) continue;
    if (t.timestamp < opts.now - windowSec) continue;
    const k = key(t.chain, t.token);
    const e = out.get(k) ?? { amount: 0, amountUSD: 0, hasUSD: true, transfers: [] };
    e.amount += t.amount;
    if (typeof t.amountUSD === "number") e.amountUSD += t.amountUSD;
    else e.hasUSD = false;
    e.transfers.push(t);
    out.set(k, e);
  }

  const findings: Finding[] = [];
  for (const [k, e] of out) {
    const b = balances.find((x) => key(x.chain, x.token) === k);
    if (!b) continue; // no current balance means no denominator, so no claim
    const start = b.amount + e.amount; // balance before the outflows
    if (start <= 0) continue;
    const ratio = e.amount / start;
    if (ratio <= threshold) continue;
    const sym = b.tokenSymbol ?? e.transfers[0]?.tokenSymbol ?? b.token;
    const pct = Math.round(ratio * 100);
    const hours = Math.round(windowSec / 3600);
    findings.push({
      rule: "R2",
      severity: "HIGH",
      title: `${pct}% of ${sym} left ${opts.wallet} in ${hours}h (${e.amount} of ${start}${e.hasUSD ? `, about ${Math.round(e.amountUSD)} USD` : ""}) across ${e.transfers.length} transfer(s)`,
      evidence: {
        chain: b.chain,
        token: b.token,
        tokenSymbol: sym,
        outflow: e.amount,
        outflowUSD: e.hasUSD ? Math.round(e.amountUSD) : null,
        balanceNow: b.amount,
        balanceStart: start,
        ratio,
        threshold,
        destinations: [...new Set(e.transfers.map((t) => t.to))],
        transfers: e.transfers.map((t) => ({ amount: t.amount, to: t.to, timestamp: t.timestamp })),
        source: b.source,
      },
      recommendedAction: { kind: "alertOwner", message: `${pct}% of ${sym} left the wallet in ${hours}h` },
    });
  }
  return findings;
}
