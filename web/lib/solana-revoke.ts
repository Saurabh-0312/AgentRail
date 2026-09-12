/**
 * Gating for the Solana revoke control, pure so it is testable without a wallet. `revoke_mandate`
 * closes the account: the handler zeroes every byte and Anchor drains the lamports and hands the
 * account to the System Program. It is not a flag and it is not reversible; recreating means
 * create_mandate, add_permission and spl-token approve again. The copy says so before the click.
 */
import { solanaErrorText } from "./solana-form";

export interface RevokeRead {
  active: boolean;
  /** unix seconds */
  expiry: number;
  permissions: number;
}

export type RevokeState = "loading" | "missing" | "disconnected" | "wrong-account" | "ready";

export interface RevokeGate {
  enabled: boolean;
  state: RevokeState;
  reason: string;
}

export const REVOKE_WARNING = "This closes the mandate account. Recreating it needs all three steps again.";

/** What the button may do, and why not: account first (nothing to send for a missing one), then the wallet. */
export function revokeGate(wallet: { enabled: boolean; state: "disconnected" | "wrong-account" | "owner"; reason: string }, mandate: RevokeRead | null | "loading"): RevokeGate {
  if (mandate === "loading") return { enabled: false, state: "loading", reason: "reading the mandate account…" };
  if (!mandate) return { enabled: false, state: "missing", reason: "no Solana mandate to revoke: the account does not exist" };
  if (wallet.state === "disconnected") return { enabled: false, state: "disconnected", reason: wallet.reason };
  if (wallet.state === "wrong-account") return { enabled: false, state: "wrong-account", reason: wallet.reason };
  return { enabled: true, state: "ready", reason: wallet.reason };
}

/** The program's error, named; 6009 is the one a non-owner would hit. */
export function revokeErrorText(e: unknown, owner: string): string {
  const text = solanaErrorText(e);
  if (/^6009\b/.test(text) || /Unauthorized/.test(text)) return `6009 Unauthorized: only the owner ${owner.slice(0, 4)}…${owner.slice(-4)} can revoke this mandate; the signer is not the owner`;
  if (/AccountNotInitialized|AccountOwnedByWrongProgram|^3007\b|^3012\b/.test(text)) return "the mandate account no longer exists: it was already revoked";
  return text;
}
