"use client";

import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Amount } from "@/components/amount";
import { ChainBadge } from "@/components/chain-badge";
import { RunLogView, phaseAfter, type LiveEntry, type RunSummary, type StreamStatus } from "@/components/run-log";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ChainKey } from "@/lib/chains";

export interface BudgetLine {
  chain: ChainKey;
  active: boolean;
  /** Σ remaining lifetime caps in the chain's asset, null when unlimited. */
  remaining: string | null;
  perTx: string | null;
}

interface Frame {
  event: string;
  data: string;
}

/** Split an SSE byte stream into events; comments and keepalives are dropped. */
export function parseSse(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

/**
 * One click, one monitor pass, watched live. Not owner-gated: a judge must be able to press it,
 * which is why the budget it will spend is shown first and why one run at a time is enforced on
 * the server. Every entry arrives the moment the agent logs it; a refusal is loud and the run
 * continues; a dropped connection leaves what was delivered on screen.
 */
export function ActivateAgent({ name, wallet, budget, feedService }: { name: string; wallet: string; budget: BudgetLine[]; feedService: string }) {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [entries, setEntries] = useState<LiveEntry[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rails, setRails] = useState<{ chain: string; state: string; detail: string }[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const downloadUrl = useRef<string | null>(null);
  /** Entries received so far, readable from inside the stream loop without a stale closure. */
  const received = useRef(0);

  useEffect(() => () => abort.current?.abort(), []);

  // follow the newest entry unless the reader scrolled up to look at something
  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, status]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const run = async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setEntries([]);
    received.current = 0;
    setSummary(null);
    setError(null);
    setRails([]);
    setStatus("connecting");
    stick.current = true;
    setStartedAt(new Date().toISOString());
    let finished = false;
    try {
      const res = await fetch(`/api/agent/run?name=${encodeURIComponent(name)}&wallet=${encodeURIComponent(wallet)}`, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setStatus("failed");
        return;
      }
      setStatus("running");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSse(buffer);
        buffer = rest;
        for (const f of frames) {
          let data: unknown;
          try {
            data = JSON.parse(f.data);
          } catch {
            continue;
          }
          if (f.event === "entry") {
            received.current += 1;
            setEntries((es) => [...es, data as LiveEntry]);
          }
          else if (f.event === "ready") setRails((data as { rails: { chain: string; state: string; detail: string }[] }).rails ?? []);
          else if (f.event === "done") {
            setSummary(data as RunSummary);
            setStatus("done");
            finished = true;
          } else if (f.event === "failed") {
            setError((data as { message?: string }).message ?? "unknown");
            setStatus("failed");
            finished = true;
          }
        }
      }
      if (!finished) setStatus("ended-early");
    } catch (e) {
      if (ac.signal.aborted) return;
      // a connection that dies mid-run is "ended early" when anything arrived: what arrived is real and stays
      if (!finished) setStatus(received.current > 0 ? "ended-early" : "failed");
      if (!finished) setError(e instanceof Error ? e.message : String(e));
    }
  };

  const transcriptHref = () => {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    const blob = new Blob([JSON.stringify({ agent: name, wallet, startedAt, status, summary, entries }, null, 2)], { type: "application/json" });
    downloadUrl.current = URL.createObjectURL(blob);
    return downloadUrl.current;
  };

  const running = status === "connecting" || status === "running";
  const phase = phaseAfter(entries[entries.length - 1], status);

  return (
    <Card accent="agent" id="activate" className="scroll-mt-20">
      <CardHeader className="text-center">
        <CardTitle className="text-[1.3125rem]">Activate Agent</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-2 text-sm" data-testid="budget">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">budget before this run</span>
          <div className="flex flex-wrap justify-center gap-2">
            {budget.map((b) => (
              <span key={b.chain} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-sunken/70 px-2.5 py-1.5 tnum">
                <ChainBadge chain={b.chain} />
                {!b.active ? <Badge variant="blocked">no active mandate</Badge> : b.remaining === null ? <span>unlimited</span> : <Amount chain={b.chain} units={b.remaining} secondary="tooltip" />}
                {b.active && b.perTx && <span className="text-xs text-muted">(max <Amount chain={b.chain} units={b.perTx} secondary="none" /> per tx)</span>}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={run} disabled={running} data-testid="activate" size="lg">
            <Play className="size-4" /> {running ? "running…" : status === "idle" ? "Activate Agent" : "Run again"}
          </Button>
          {(status === "done" || status === "ended-early" || status === "failed") && entries.length > 0 && (
            <a className="text-xs underline" href={transcriptHref()} download={`${name}-${(startedAt ?? "run").replace(/[:.]/g, "-")}.json`} data-testid="transcript">
              download the transcript ({entries.length} entries)
            </a>
          )}
        </div>
        {rails.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs" data-testid="rails">
            {rails.map((r) => (
              <span key={r.chain} title={r.detail}>
                <Badge variant={r.state === "ready" ? "allowed" : r.state === "read-only" ? "neutral" : "warn"}>{r.chain} · {r.state}</Badge>
              </span>
            ))}
          </div>
        )}
        {(entries.length > 0 || running || status === "failed") && (
          <div ref={scroller} onScroll={onScroll} className="max-h-[32rem] overflow-y-auto rounded-lg border border-border bg-surface-sunken/60 p-2" data-testid="log">
            <RunLogView entries={entries} status={status} summary={summary} error={error} phase={phase} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
