"use client";

import { Addr } from "@/components/addr";
import { Badge } from "@/components/ui/badge";
import { CHAINS, errorReason } from "@/lib/chains";
import { cn } from "@/lib/cn";
import { useLiveMarks, type LiveMark } from "@/lib/attack-store";

/** One recorded attack, as the page passes it: the 10 Sept evidence plus whether the index carries it. */
export interface AttackRow {
  id: string;
  n: string;
  title: string;
  toldTo: string;
  did: string;
  gate: string;
  code: number;
  error: string;
  /** The recorded signature; null for an attack that exists only in the live run. */
  tx: string | null;
  /** Block time of the recorded signature (ISO), from the index. */
  recordedAt: string | null;
  indexed: boolean;
  improvised?: boolean;
  /** Recorded only, with the reason it is not reproduced live. */
  recordedOnly?: string;
  before?: { what: string; tx: string };
  after?: { what: string; tx: string };
}

/** Full date and time, so a reader can see the live one is minutes old and the recorded one is not. */
const stamp = (iso: string) => iso.replace("T", " ").slice(0, 19) + " UTC";

function LiveCell({ m, recordedOnly }: { m: LiveMark | undefined; recordedOnly?: string }) {
  if (recordedOnly) return <div className="text-[11px] text-muted">recorded only: {recordedOnly}</div>;
  if (!m) return <div className="text-[11px] text-muted">press “Run the attack”</div>;
  const refused = m.status === "refused" || m.status === "refused-other";
  return (
    <div className="space-y-1" data-testid={`live-${m.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mono text-[11px] text-ink tnum" data-testid="live-at">{stamp(m.at)}</span>
        {refused ? <Badge variant="blocked-solid">{`REVERTED ${m.errorCode ?? ""}`}</Badge> : m.status === "SUCCEEDED" ? <Badge variant="warn">LANDED</Badge> : <Badge variant="warn">{m.status}</Badge>}
      </div>
      {m.errorName && <div className="text-[11px] font-medium text-blocked">{m.errorName}</div>}
      {m.signature && <Addr value={m.signature} href={m.explorer ?? CHAINS.solana.tx(m.signature)} head={8} tail={6} className="text-xs" />}
    </div>
  );
}

/** The attack rows: what the model was told and did, what the chain said on 10 Sept, and what it said in the reader's last run. */
export function AttackRows({ rows }: { rows: AttackRow[] }) {
  const marks = useLiveMarks();
  const sol = CHAINS.solana;
  return (
    <ol className="relative space-y-2 before:absolute before:left-[1.05rem] before:top-2 before:bottom-2 before:w-px before:bg-border" data-testid="attack-rows">
      {rows.map((a) => {
        const m = marks[a.id];
        return (
          <li key={a.id} className={cn("relative rounded-lg border border-border border-l-4 bg-surface p-3 pl-12 shadow-1", a.improvised ? "border-l-warn" : "border-l-blocked")} data-row={a.id}>
            <span className={cn("absolute left-2 top-3 inline-flex size-6 items-center justify-center rounded-full text-[11px] font-bold text-ink-inverse shadow-1", a.improvised ? "bg-warn" : "bg-blocked")} aria-hidden>
              {a.n}
            </span>
            <div className="grid gap-x-5 gap-y-2 text-xs lg:grid-cols-[1.3fr_1fr_1fr]">
              <div className="space-y-0.5">
                <div className="text-sm font-semibold">{a.title}</div>
                <div className="text-[11px] text-muted"><span className="font-medium text-ink">told:</span> {a.toldTo}</div>
                <div className="text-[11px] text-muted"><span className="font-medium text-ink">did:</span> {a.did}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted">recorded</div>
                {a.recordedAt && <div className="mono text-[11px] text-ink tnum">{stamp(a.recordedAt)}</div>}
                {a.tx ? (
                  <>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="solana">{a.gate}</Badge>
                      <Badge variant="blocked">{`REVERTED ${a.code}`}</Badge>
                    </div>
                    <div className="text-[11px] font-medium text-blocked">{a.error}</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Addr value={a.tx} href={sol.tx(a.tx)} head={8} tail={6} />
                      {a.indexed ? <Badge variant="allowed" title="a row in the shared index">indexed</Badge> : <Badge variant="warn" title="not in the committed snapshot">not in snapshot</Badge>}
                    </div>
                    {a.before && <div className="text-[10px] text-muted">before: {a.before.what} <Addr value={a.before.tx} href={sol.tx(a.before.tx)} head={6} tail={4} /></div>}
                    {a.after && <div className="text-[10px] text-muted">after: {a.after.what} <Addr value={a.after.tx} href={sol.tx(a.after.tx)} head={6} tail={4} /></div>}
                  </>
                ) : (
                  <div className="text-[11px] text-muted">live only: a hand-built instruction, no model was asked</div>
                )}
                <div className="text-[11px] text-muted">{errorReason(a.code)}</div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-blocked"><span className="dot-live" aria-hidden /> live · your last run</div>
                <LiveCell m={m} recordedOnly={a.recordedOnly} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
