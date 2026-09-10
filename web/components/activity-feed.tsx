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
export function ActivityFeed({ rows, initialMode = "all" }: { rows: FeedRow[]; initialMode?: FeedMode }) {
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
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={mode === m.key}
            onClick={() => setMode(m.key)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm tnum",
              mode === m.key ? (m.key === "blocked" ? "border-blocked bg-blocked text-ink-inverse" : "border-ink bg-ink text-ink-inverse") : "border-border bg-surface text-ink hover:bg-muted-soft",
            )}
          >
            {m.label}
            <span className={cn("rounded px-1.5 text-xs", mode === m.key ? "bg-ink-inverse/20" : m.key === "blocked" ? "bg-blocked-soft text-blocked" : "bg-muted-soft text-muted")}>{counts[m.key]}</span>
          </button>
        ))}
      </div>

      <Table>
        <THead>
          <TR>
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
              <TR key={r.id} data-verdict={blocked ? "blocked" : "allowed"} className={cn(blocked && "border-l-4 border-l-blocked bg-blocked-soft/50")}>
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
                      <Badge variant="blocked">{`BLOCKED${r.errorCode ? ` ${r.errorCode}` : ""}`}</Badge>
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
