"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { ChainBadge } from "@/components/chain-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CHAINS, errorName, errorReason, type ChainKey } from "@/lib/chains";
import { cn } from "@/lib/cn";
import { actionLabel, countRows, filterRows, type FeedMode } from "@/lib/feed";
import { isoDate, timeAgo } from "@/lib/format";
import type { FeedRow } from "@/lib/history";

/** What the Solana leg is made of: a snapshot for history, an RPC tail for the recent window. */
export interface LiveMeta {
  ensNode: string;
  historySyncedAt: string;
  historyThroughSlot: number;
  tail: { throughSlot: number; fetchedAt: string; error: string | null; stale?: boolean; loading?: boolean };
}

interface TailResponse {
  tail: { throughSlot: number; fetchedAt: string; error: string | null; stale: boolean; loading: boolean; rows: number };
  feed: FeedRow[];
}

/** Rows the refresh brought in, merged by id, newest first. */
export function mergeFeed(current: FeedRow[], incoming: FeedRow[]): { rows: FeedRow[]; added: string[] } {
  const have = new Set(current.map((r) => r.id));
  const added = incoming.filter((r) => !have.has(r.id));
  const rows = [...current, ...added].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return { rows, added: added.map((r) => r.id) };
}

/**
 * The unified feed. Successes are quiet; refusals are loud: a red left border, a red badge with the
 * error code, and the reason in words. Blocked is one click away and is never hidden to tidy the list.
 * With `live`, the Solana leg shows both of its timestamps and a Refresh that refetches the tail only.
 */
export function ActivityFeed({
  rows: initialRows,
  initialMode = "all",
  dense = false,
  sticky = false,
  live,
}: {
  rows: FeedRow[];
  initialMode?: FeedMode;
  dense?: boolean;
  /** Pin the header to the page while the table scrolls (laptop widths and up). */
  sticky?: boolean;
  live?: LiveMeta;
}) {
  const [mode, setMode] = useState<FeedMode>(initialMode);
  const [rows, setRows] = useState<FeedRow[]>(initialRows);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [tail, setTail] = useState(live?.tail ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastAdded, setLastAdded] = useState<number | null>(null);
  const counts = countRows(rows);
  const shown = filterRows(rows, mode);
  const modes: { key: FeedMode; label: string }[] = [
    { key: "all", label: "All" },
    { key: "allowed", label: "Allowed" },
    { key: "blocked", label: "Blocked" },
  ];

  // the server rendered before its first read of the tail finished: collect it once, shortly after paint
  useEffect(() => {
    if (!live?.tail.loading) return;
    const t = setTimeout(() => void refresh(), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    if (!live) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/solana-tail?ensNode=${live.ensNode}&force=1`, { cache: "no-store" });
      const body = (await res.json()) as TailResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setTail({ throughSlot: body.tail.throughSlot, fetchedAt: body.tail.fetchedAt, error: body.tail.error, stale: body.tail.stale, loading: body.tail.loading });
      if (!body.tail.error || body.tail.stale) {
        const merged = mergeFeed(rows, body.feed);
        setRows(merged.rows);
        setFresh(new Set(merged.added));
        setLastAdded(merged.added.length);
      }
    } catch (e) {
      setTail((t) => ({ throughSlot: t?.throughSlot ?? live.historyThroughSlot, fetchedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="verdict filter">
        {modes.map((m) => {
          const active = mode === m.key;
          const isBlocked = m.key === "blocked";
          return (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setMode(m.key)}
              className={cn(
                "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm tnum shadow-1",
                isBlocked && "font-semibold",
                active ? (isBlocked ? "border-blocked bg-blocked text-ink-inverse shadow-2" : "border-ink bg-ink text-ink-inverse") : isBlocked ? "border-blocked/50 bg-blocked-soft text-blocked hover:border-blocked hover:shadow-2" : "border-border bg-surface text-ink hover:border-border-strong hover:bg-muted-soft",
              )}
            >
              {m.label}<span className={cn("rounded px-1.5 text-xs", active ? "bg-ink-inverse/20" : isBlocked ? "bg-blocked/15 text-blocked" : "bg-muted-soft text-muted")}>{counts[m.key]}</span>
            </button>
          );
        })}
        {live && (
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted tnum" data-testid="live-meta">
            <span>
              <ChainBadge chain="solana" /> history synced {isoDate(Math.floor(Date.parse(live.historySyncedAt) / 1000)).slice(0, 16)}, to slot {live.historyThroughSlot}
            </span>
            {tail?.loading ? (
              <span className="text-muted" data-testid="live-loading">live tail loading…</span>
            ) : tail && (!tail.error || tail.stale) ? (
              <span className="text-ink" data-testid="live-through">
                live through slot {tail.throughSlot}, {timeAgo(Math.floor(Date.parse(tail.fetchedAt) / 1000))}
                {tail.error && <span className="text-warn"> · refresh failed, showing the last good read</span>}
              </span>
            ) : (
              <span className="text-warn" data-testid="live-unavailable">live tail unavailable, showing history to slot {live.historyThroughSlot}</span>
            )}
            {lastAdded !== null && <span className={cn(lastAdded > 0 ? "text-allowed" : "text-muted")} data-testid="live-added">{lastAdded > 0 ? `+${lastAdded} new` : "nothing new"}</span>}
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} data-testid="refresh">
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} /> {refreshing ? "reading…" : "Refresh"}
            </Button>
          </span>
        )}
      </div>

      <Table dense={dense} stickyHeader={sticky}>
        <THead sticky={sticky}>
          <TR className="hover:bg-transparent">
            <TH>time</TH>
            <TH>chain</TH>
            <TH>action</TH>
            <TH>target</TH>
            <TH className="text-right">amount</TH>
            <TH>verdict</TH>
            <TH>tx</TH>
          </TR>
        </THead>
        <TBody>
          {shown.length === 0 && (
            <TR>
              <TD colSpan={7} className="py-8 text-center text-muted">
                nothing in this view
              </TD>
            </TR>
          )}
          {shown.map((r) => {
            const chain = r.chain as ChainKey;
            const meta = CHAINS[chain];
            const ts = Number(r.timestamp);
            const blocked = !r.allowed;
            return (
              <TR key={r.id} data-verdict={blocked ? "blocked" : "allowed"} data-new={fresh.has(r.id) ? "1" : undefined} className={cn(blocked && "border-l-4 border-l-blocked bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_45%)] hover:bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_70%)]")}>
                <TD className="whitespace-nowrap tnum">
                  <div>{timeAgo(ts)}</div>
                  <div className="text-[11px] text-muted">{isoDate(ts)}</div>
                </TD>
                <TD>{meta ? <ChainBadge chain={chain} /> : r.chain}</TD>
                <TD className="mono whitespace-nowrap">{actionLabel(r)}</TD>
                <TD>{meta && r.target ? <Addr value={r.target} href={meta.address(r.target)} /> : r.target}</TD>
                <TD className="text-right whitespace-nowrap tnum">{r.amount && r.amount !== "0" ? <Amount chain={r.chain} units={r.amount} secondary="below" className="items-end" /> : "—"}</TD>
                <TD>
                  {blocked ? (
                    <div className="space-y-0.5">
                      <Badge variant="blocked-solid" className="font-semibold tracking-wide">{`BLOCKED${r.errorCode ? ` ${r.errorCode}` : ""}`}</Badge>
                      <div className="text-xs text-blocked">
                        {errorName(r.errorCode) ?? r.blockReason ?? "refused"}
                        {errorReason(r.errorCode) ? <span className="text-muted"> · {errorReason(r.errorCode)}</span> : null}
                      </div>
                    </div>
                  ) : (
                    <Badge variant="allowed">allowed</Badge>
                  )}
                </TD>
                <TD>{meta ? <Addr value={r.txHash} href={meta.tx(r.txHash)} head={8} tail={4} /> : r.txHash}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
