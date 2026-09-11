/**
 * The delegation step, as pure functions so it is tested without a wallet. `executePayment` pulls
 * the owner's tokens with `transferFrom`, so a mandate can only pay what the owner has approved
 * `EvmMandate` to move: the allowance is the non-custodial mechanism itself, not a setup detail.
 */

/** What the server read for an EVM mandate: the token it settles in and the owner's standing with it. */
export interface Funding {
  token: string;
  symbol: string;
  decimals: number;
  /** `allowance(owner, EvmMandate)` in base units. */
  allowance: string;
  /** The owner's balance of the token, in base units. */
  balance: string;
  /** What the mandate can still pull: the sum of every permission's remaining lifetime cap; null when a cap is unlimited. */
  required: string | null;
}

export type FundingState = "funded" | "under-funded" | "unfunded" | "nothing-to-fund";

export interface FundingStatus {
  state: FundingState;
  /** How much more allowance the mandate needs to cover its caps (0 when funded). */
  shortfall: string;
  /** The allowance covers the caps, but the owner's balance would not. */
  balanceShort: boolean;
}

const big = (s: string | null | undefined) => {
  try {
    return BigInt((s ?? "0").trim() || "0");
  } catch {
    return 0n;
  }
};

/** The allowance a mandate needs: every permission's lifetime cap minus what it already spent. Null when any cap is unlimited. */
export function requiredAllowance(permissions: { total: string; spent: string }[]): string | null {
  let sum = 0n;
  for (const p of permissions) {
    const total = big(p.total);
    if (total === 0n) return null;
    const left = total - big(p.spent);
    if (left > 0n) sum += left;
  }
  return sum.toString();
}

export function fundingStatus(f: Pick<Funding, "allowance" | "balance" | "required">): FundingStatus {
  const allowance = big(f.allowance);
  const balance = big(f.balance);
  if (f.required === null) {
    return allowance > 0n ? { state: "funded", shortfall: "0", balanceShort: balance < allowance } : { state: "unfunded", shortfall: "0", balanceShort: false };
  }
  const required = big(f.required);
  if (required === 0n) return { state: "nothing-to-fund", shortfall: "0", balanceShort: false };
  if (allowance === 0n) return { state: "unfunded", shortfall: required.toString(), balanceShort: balance < required };
  if (allowance < required) return { state: "under-funded", shortfall: (required - allowance).toString(), balanceShort: balance < required };
  return { state: "funded", shortfall: "0", balanceShort: balance < required };
}

/** Step 3 is already done when the standing allowance covers the amount the owner is about to approve. */
export function stepSatisfied(allowance: string, amount: string): boolean {
  const a = big(amount);
  return a > 0n && big(allowance) >= a;
}

/** What to pre-fill in the approve field for an existing mandate: the absolute allowance that covers its caps. */
export function suggestedAllowance(f: Pick<Funding, "allowance" | "required">): string {
  if (f.required === null) return big(f.allowance) > 0n ? f.allowance : "0";
  return f.required;
}

/** The one line that teaches the mechanism. */
export const DELEGATION_COPY = "Tokens stay in your wallet; the mandate decides what moves.";

export const STEPS = [
  { n: 1, title: "Create mandate", call: "createMandate(agent, ensNode, expiry)" },
  { n: 2, title: "Add permission", call: "addPermission(mandateId, destination, spendLimit, perTxLimit)" },
  { n: 3, title: "Delegate funds", call: "IERC20(token).approve(EvmMandate, amount)" },
] as const;

export type StepState = "idle" | "pending" | "confirmed" | "failed" | "satisfied";

export interface StepProgress {
  state: StepState;
  hash?: string;
  note?: string;
}
