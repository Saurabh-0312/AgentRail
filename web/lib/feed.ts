/** Client-safe helpers for the activity feed; no server imports so the component and its tests share them. */
import type { FeedRow } from "./history";

export type FeedMode = "all" | "allowed" | "blocked";

export function filterRows(rows: FeedRow[], mode: FeedMode): FeedRow[] {
  if (mode === "allowed") return rows.filter((r) => r.allowed);
  if (mode === "blocked") return rows.filter((r) => !r.allowed);
  return rows;
}

export function countRows(rows: FeedRow[]): Record<FeedMode, number> {
  const blocked = rows.filter((r) => !r.allowed).length;
  return { all: rows.length, allowed: rows.length - blocked, blocked };
}

/** What the row was: the program instruction (Solana) or the contract call (EVM). */
export function actionLabel(row: FeedRow): string {
  switch (row.kind) {
    case "execute_payment":
      return "execute_payment";
    case "verify":
      return "verify";
    case "authorize":
      return "authorize";
    case "payment":
      return "executePayment";
    default:
      return row.kind;
  }
}
