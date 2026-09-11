/**
 * GET /api/solana-tail?ensNode=0x…[&force=1]
 *
 * The live Solana tail since the committed snapshot, as snapshot-shaped rows plus the feed rows
 * for one mandate (folded with the same `foldSolana` the history uses). Failed transactions are
 * rows too. Cached ~45 s on the server; `force=1` bypasses the cache for the Refresh button.
 */
import { foldSolana } from "@agentrail/query/src/history.ts";

import { PUBLIC } from "@/lib/env";
import { toFeed } from "@/lib/history";
import { loadSolanaSnapshot } from "@/lib/solana-snapshot";
import { solanaTail } from "@/lib/solana-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A first read of the window is a few dozen spaced RPC calls; the refresh waits for it. */
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ensNode = url.searchParams.get("ensNode") ?? PUBLIC.ensNode;
  if (!/^0x[0-9a-fA-F]{64}$/.test(ensNode)) return Response.json({ error: "ensNode must be a bytes32 hex string" }, { status: 400 });
  const snap = loadSolanaSnapshot();
  // a refresh waits for the read (up to the function's own limit); a page render only waits a little
  const tail = await solanaTail(url.searchParams.get("force") === "1", 50_000);
  const feed = toFeed(foldSolana(tail.rows, ensNode));
  return Response.json(
    { history: { syncedAt: snap.syncedAt, throughSlot: snap.nextBlock - 1 }, tail: { fromSlot: tail.fromSlot, throughSlot: tail.throughSlot, fetchedAt: tail.fetchedAt, signatures: tail.signatures, rows: tail.rows.length, truncated: tail.truncated ?? false, stale: tail.stale ?? false, loading: tail.loading ?? false, error: tail.error ?? null }, feed },
    { headers: { "Cache-Control": "no-store" } },
  );
}
