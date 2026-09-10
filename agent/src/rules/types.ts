/**
 * The shapes the rules reason over, and the verdict they produce. Everything here is plain data:
 * the rules are pure functions of it (r1/r2/r3), and the data is built by adapt.ts from what the
 * tools fetched. Severity lives here, and it is decided by the rules, never by a model (SPEC §8.7).
 */
export type Severity = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const SEVERITY_RANK: Record<Severity, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** The higher of two severities. */
export const maxSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/** A token approval (EVM) or delegation (Solana) granted from the watched account. */
export interface ApprovalEvent {
  chain: string;
  /** Token contract (EVM) or token account (Solana). */
  token: string;
  tokenSymbol?: string;
  owner: string;
  spender: string;
  /** Raw amount, as a decimal integer string. */
  amount: string;
  /** Set when the source already knows the approval is unlimited. */
  unlimited?: boolean;
  timestamp: number;
  /** What is known about the spender; absent when nothing is known (which is not the same as "no history"). */
  spenderHistory?: {
    /** Transactions the spender has been part of. 0 is the drainer signature. */
    txCount?: number | null;
    firstSeen?: number | null;
    /** true for a recognised protocol, false for a contract the source could not identify. */
    known?: boolean;
    label?: string;
  };
  source: string;
}

/** A transfer out of the watched account. */
export interface TransferEvent {
  chain: string;
  token: string;
  tokenSymbol?: string;
  /** Human units. */
  amount: number;
  amountUSD?: number;
  from: string;
  to: string;
  timestamp: number;
  source: string;
}

/** A current balance, the denominator R2 needs. */
export interface Balance {
  chain: string;
  token: string;
  tokenSymbol?: string;
  amount: number;
  amountUSD?: number;
  source: string;
}

/** A lending position, for R3. */
export interface LendingPosition {
  protocol: string;
  chain: string;
  /** As reported by the source; otherwise computed from the parts. */
  healthFactor?: number | null;
  collateralUSD?: number;
  debtUSD?: number;
  /** Weighted liquidation threshold, 0..1. */
  liquidationThreshold?: number;
  source: string;
}

/** What a finding recommends. `revokeApproval` is the only one that becomes an on-chain attempt. */
export type RecommendedAction =
  | { kind: "revokeApproval"; chain: string; token: string; account: string; spender: string }
  | { kind: "alertOwner"; message: string }
  | { kind: "log"; message: string };

export interface Finding {
  rule: "R1" | "R2" | "R3";
  severity: Severity;
  title: string;
  evidence: Record<string, unknown>;
  recommendedAction: RecommendedAction;
}

/** Everything the rules run over, for one subject. */
export interface RiskData {
  wallet: string;
  approvals: ApprovalEvent[];
  transfers: TransferEvent[];
  balances: Balance[];
  positions: LendingPosition[];
}

/** One risk verdict: a decision, not a printout. */
export interface Verdict {
  subject: string;
  severity: Severity;
  findings: Finding[];
  /** The decision in sentences: what was found, how it was weighed, what follows. */
  reasoning: string;
  recommendedAction: RecommendedAction;
  at: string;
}
