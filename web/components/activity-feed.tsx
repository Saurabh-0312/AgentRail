"use client";

import { useState } from "react";

import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { ChainBadge } from "@/components/chain-badge";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CHAINS, errorName, errorReason, type ChainKey } from "@/lib/chains";
import { cn } from "@/lib/cn";
import { actionLabel, countRows, filterRows, type FeedMode } from "@/lib/feed";
import { isoDate, timeAgo } from "@/lib/format";
import type { FeedRow } from "@/lib/history";

/**
 * The unified feed. Successes are quiet; refusals are loud: a red left border, a red badge with the
 * error code, and the reason in words. Blocked is one click away and is never hidden to tidy the list.
 */
export function ActivityFeed({
  rows,
  initialMode = "all",
  dense = false,
  sticky = false,
}: {
  rows: FeedRow[];
  initialMode?: FeedMode;
  dense?: boolean;
  /** Pin the header to the page while the table scrolls (laptop widths and up). */
  sticky?: boolean;
}) {
  const [mode, setMode] = useState<FeedMode>(initialMode);
  const counts = countRows(rows);
  const shown = filterRows(rows, mode);
  const modes: { key: FeedMode; label: string }[] = [
    { key: "all", label: "All" },
    { key: "allowed", label: "Allowed" },
    { key: "blocked", label: "Blocked" },
  ];
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
              <TR key={r.id} data-verdict={blocked ? "blocked" : "allowed"} className={cn(blocked && "border-l-4 border-l-blocked bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_45%)] hover:bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_70%)]")}>
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
