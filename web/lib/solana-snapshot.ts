/**
 * The Solana leg of the shared schema comes from a Substreams stream that the reader caches in a
 * local, gitignored file (`indexer/query/out`). A deployed site cannot read that file, so the app
 * ships a snapshot of it as product data (`web/data/solana-activity.json`), written by
 * `yarn workspace @agentrail/web snapshot:solana`. Its `syncedAt` is shown in the UI: it is a
 * snapshot of a live stream, and the site never pretends otherwise.
 */
import type { SolanaRow } from "@agentrail/query/src/solana-sink.ts";

import snapshot from "@/data/solana-activity.json";

export interface SolanaSnapshot {
  syncedAt: string;
  endpoint: string;
  initialBlock: number;
  nextBlock: number;
  rowCount: number;
  rows: SolanaRow[];
}

export function loadSolanaSnapshot(): SolanaSnapshot {
  return snapshot as unknown as SolanaSnapshot;
}
