/**
 * One query, three chains, on the server. The two Studio endpoints are queried with the API key
 * from the server environment; the Solana leg is folded from the committed snapshot. This is
 * `@agentrail/query`'s `fetchHistory` with the sink swapped for the snapshot: the web app does not
 * re-implement the query.
 */
import "server-only";

import { fetchHistory, type Action, type FetchLike, type HistoryResult, type Mandate } from "@agentrail/query/src/history.ts";

import { serverEnv } from "./env";
import { solanaTail } from "./solana-live";
import { loadSolanaSnapshot } from "./solana-snapshot";
import { mergeRows, type TailResult } from "./solana-tail";

export interface FeedRow extends Action {
  chain: string;
  mandateId: string;
}

export interface HistoryPayload extends HistoryResult {
  /** Every action across the three chains, newest first. */
  feed: FeedRow[];
  summary: { actions: number; allowed: number; blocked: number; chains: number; blockedByCode: Record<string, number> };
  solana: {
    syncedAt: string;
    endpoint: string;
    nextBlock: number;
    rowCount: number;
    /** The live RPC tail merged on top of the snapshot (GAP 4); `error` set when the RPC could not be read. */
    tail: { fromSlot: number; throughSlot: number; fetchedAt: string; rows: number; signatures: number; truncated: boolean; stale: boolean; loading: boolean; error: string | null };
  };
}

export function toFeed(mandates: Mandate[]): FeedRow[] {
  return mandates
    .flatMap((m) => m.actions.map((a) => ({ ...a, chain: m.chain, mandateId: m.id })))
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
}

export function summarize(feed: FeedRow[], chains: number): HistoryPayload["summary"] {
  const blocked = feed.filter((a) => !a.allowed);
  const blockedByCode: Record<string, number> = {};
  for (const b of blocked) {
    const k = b.errorCode ? String(b.errorCode) : (b.blockReason ?? "FAILED");
    blockedByCode[k] = (blockedByCode[k] ?? 0) + 1;
  }
  return { actions: feed.length, allowed: feed.length - blocked.length, blocked: blocked.length, chains, blockedByCode };
}

export async function history(ensNode: string, opts: { fetch?: FetchLike; snapshot?: ReturnType<typeof loadSolanaSnapshot>; tail?: TailResult | null } = {}): Promise<HistoryPayload> {
  const snap = opts.snapshot ?? loadSolanaSnapshot();
  // the live tail rides on top of the snapshot; a test that injects a snapshot injects its tail too (or none)
  const tail: TailResult | null = opts.tail !== undefined ? opts.tail : opts.snapshot ? null : await solanaTail();
  const rows = tail ? mergeRows(snap.rows, tail.rows) : snap.rows;
  const result = await fetchHistory(ensNode, {
    sepoliaUrl: serverEnv.subgraphSepolia(),
    baseUrl: serverEnv.subgraphBase(),
    apiKey: serverEnv.graphApiKey(),
    solanaRows: () => rows,
    fetch: opts.fetch,
  });
  const feed = toFeed(result.mandates);
  const chains = new Set(result.mandates.map((m) => m.chain)).size;
  return {
    ...result,
    feed,
    summary: summarize(feed, chains),
    solana: {
      syncedAt: snap.syncedAt,
      endpoint: snap.endpoint,
      nextBlock: snap.nextBlock,
      rowCount: snap.rowCount,
      tail: tail
        ? { fromSlot: tail.fromSlot, throughSlot: tail.throughSlot, fetchedAt: tail.fetchedAt, rows: tail.rows.length, signatures: tail.signatures, truncated: tail.truncated ?? false, stale: tail.stale ?? false, loading: tail.loading ?? false, error: tail.error ?? null }
        : { fromSlot: snap.nextBlock, throughSlot: snap.nextBlock - 1, fetchedAt: snap.syncedAt, rows: 0, signatures: 0, truncated: false, stale: false, loading: false, error: "live tail not read" },
    },
  };
}
