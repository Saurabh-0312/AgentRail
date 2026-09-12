import { Addr } from "@/components/addr";
import { Badge } from "@/components/ui/badge";
import { CHAINS } from "@/lib/chains";
import { cn } from "@/lib/cn";

/** One RunLog entry as the agent emits it (agent/src/transcript.ts). */
export interface LiveEntry {
  seq: number;
  at: string;
  kind: "tool" | "model" | "decision" | "refusal" | "chain" | "alert" | "payment" | "action" | "finding" | "verdict" | "note";
  title: string;
  data?: Record<string, unknown>;
}

export type StreamStatus = "idle" | "connecting" | "running" | "done" | "failed" | "ended-early";

export interface RunSummary {
  durationMs: number;
  entries: number;
  toolCalls: number;
  payments: number;
  refusals: number;
  paidRequests: number;
  verdict: { severity: string; reasoning: string; recommendedAction?: string };
  protocols: string[];
  purchase: { status: string; transactionId: string | null; explorer: string | null; reason: string | null } | null;
}

/** A refusal caused by the mandate itself (caps, expiry, no mandate): the thesis, not a fault. */
export function isBudgetRefusal(e: LiveEntry): boolean {
  if (e.kind !== "refusal") return false;
  const text = `${e.title} ${JSON.stringify(e.data ?? {})}`;
  return /SpendLimitExceeded|PerTxLimitExceeded|Expired|NotActive|no mandate|no-mandate|OVER_BUDGET|evm-check|local-gate/i.test(text);
}

/** What the agent is most likely doing after the last entry it emitted. */
export function phaseAfter(last: LiveEntry | undefined, status: StreamStatus): string | null {
  if (status !== "running" && status !== "connecting") return null;
  if (!last) return "Starting the runtime: reading the agent's name from ENS…";
  const t = last.title;
  if (t.startsWith("rails:")) return "Connecting the Subgraph MCP and the model…";
  if (t.startsWith("subgraph-mcp connected")) return "Reading its own mandate with the fixed query…";
  if (t.startsWith("monitor:")) return "Reading its own mandate with the fixed query…";
  if (t.startsWith("getMyMandate")) return "Discovery pass: which protocols is this wallet exposed to?";
  if (t.startsWith("discovery pass")) return "Drilling into the protocols it found…";
  if (t.startsWith("discoverService")) return "Buying price data through the mandate…";
  if (t.startsWith("requestPayment") || t.includes("402 quote") || t.includes("gate passed")) return "Waiting for the gate and the settlement…";
  if (t.startsWith("prices bought")) return "Running R1 / R2 / R3…";
  if (last.kind === "refusal") return "Continuing without the purchase…";
  if (last.kind === "model") return "Deciding what the answer means…";
  if (t.includes("mcp:") || t.startsWith("querySubgraph")) return "Exploring published subgraphs…";
  if (last.kind === "finding") return "Correlating the findings…";
  return "Working…";
}

const explorerFor = (data: Record<string, unknown> | undefined): string | null => {
  const ex = data?.explorer;
  return typeof ex === "string" && ex.startsWith("http") ? ex : null;
};

const short = (v: unknown, n = 220): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function Detail({ e }: { e: LiveEntry }) {
  const d = e.data;
  if (!d) return null;
  if (e.kind === "model" && typeof d.answer === "string") return <div className="mono mt-0.5 text-[11px] text-muted whitespace-pre-wrap break-words">{short(d.answer, 400)}</div>;
  if (e.kind === "tool" && typeof d.question === "string") return <div className="mt-0.5 text-[11px] text-muted">{short(d.question, 240)}</div>;
  if (e.kind === "tool" && typeof d.input !== "undefined") return <div className="mono mt-0.5 text-[11px] text-muted break-words">{short(d.input, 160)}</div>;
  if (e.kind === "refusal") {
    const detail = d.detail ?? d.refusedBy;
    return <div className="mt-0.5 text-xs text-blocked">{typeof d.refusedBy === "string" && <span className="mono">{d.refusedBy}</span>}{detail && typeof detail !== "string" ? <span className="mono"> {short(detail, 200)}</span> : typeof detail === "string" && detail !== d.refusedBy ? <span> {short(detail, 200)}</span> : null}</div>;
  }
  const ex = explorerFor(d);
  const tx = typeof d.transactionId === "string" ? d.transactionId : typeof d.signature === "string" ? d.signature : null;
  if (ex || tx) {
    return (
      <div className="mt-0.5 text-xs">
        {tx ? <Addr value={tx} href={ex ?? undefined} head={12} tail={8} /> : <a className="underline" href={ex!} target="_blank" rel="noreferrer">explorer</a>}
      </div>
    );
  }
  if (e.kind === "verdict" || e.kind === "finding" || e.kind === "decision") return <div className="mono mt-0.5 text-[11px] text-muted break-words">{short(d, 300)}</div>;
  return <div className="mono mt-0.5 text-[11px] text-muted break-words">{short(d, 160)}</div>;
}

const ICON: Record<LiveEntry["kind"], string> = { tool: "›", model: "≈", note: "·", decision: "→", finding: "!", payment: "$", chain: "⛓", action: "⚙", alert: "🔔", refusal: "✕", verdict: "★" };

/** The rows of a run, colour-coded by kind. Presentational, so it renders to static markup in tests. */
/** `thesis` shows the budget banner when a refusal is the mandate's own doing; a run whose refusals are the point (the live attack) turns it off. */
export function RunLogView({ entries, status, summary, error, phase, thesis = true }: { entries: LiveEntry[]; status: StreamStatus; summary?: RunSummary | null; error?: string | null; phase?: string | null; thesis?: boolean }) {
  const budgetRefusal = thesis ? entries.find(isBudgetRefusal) : undefined;
  return (
    <div className="space-y-2" data-status={status}>
      {budgetRefusal && (
        <div className="rounded-lg border border-blocked bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_70%)] p-3 text-sm" data-testid="thesis">
          <div className="font-semibold text-blocked">The mandate refused this run: the demo budget is exhausted.</div>
          <div className="text-ink">This is AgentRail working. The agent asked, the gate said no, and no money moved.</div>
          <div className="mt-1 text-xs text-muted">{budgetRefusal.title}</div>
        </div>
      )}
      <ol className="space-y-1 text-sm" data-testid="run-entries">
        {entries.map((e) => {
          const refusal = e.kind === "refusal";
          const green = e.kind === "payment" || e.kind === "chain" || e.kind === "action";
          const quiet = e.kind === "tool" || e.kind === "model" || e.kind === "note";
          return (
            <li
              key={e.seq}
              data-kind={e.kind}
              data-seq={e.seq}
              className={cn(
                "rounded-md border px-3 py-1.5",
                refusal && "border-blocked bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_60%)] text-blocked font-semibold blocked-cue",
                green && "border-allowed/40 bg-allowed-soft text-ink",
                e.kind === "verdict" && "border-ink bg-surface-sunken text-ink font-semibold text-base",
                e.kind === "alert" && "border-hedera/50 bg-hedera/10",
                quiet && "border-border/60 bg-transparent text-muted",
                !refusal && !green && !quiet && e.kind !== "verdict" && e.kind !== "alert" && "border-border bg-surface",
              )}
            >
              <div className="flex items-start gap-2">
                <span className={cn("mono w-5 shrink-0 text-center text-xs", refusal ? "text-blocked" : green ? "text-allowed" : "text-muted")}>{ICON[e.kind]}</span>
                <span className="mono w-7 shrink-0 text-[11px] text-muted tnum">{e.seq}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {refusal && <Badge variant="blocked-solid" className="font-semibold">REFUSED</Badge>}
                    {e.kind === "verdict" && <Badge variant={/CRITICAL|HIGH/.test(e.title) ? "blocked-solid" : /MEDIUM/.test(e.title) ? "warn" : "allowed"}>verdict</Badge>}
                    {green && <Badge variant="allowed">{e.kind}</Badge>}
                    <span className={cn("break-words", refusal && "text-blocked")}>{e.title.trim()}</span>
                  </div>
                  <Detail e={e} />
                </div>
                <span className="mono shrink-0 text-[10px] text-muted tnum">{e.at.slice(11, 19)}</span>
              </div>
            </li>
          );
        })}
        {phase && (
          <li className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted" data-testid="phase">
            <span className="spinner" aria-hidden />
            <span>{phase}</span>
          </li>
        )}
      </ol>
      {status === "done" && summary && (
        <div className="rounded-lg border border-border bg-surface p-3 text-sm" data-testid="summary">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tnum">
            <span className="font-semibold">🏁 Run complete</span>
            <span>{summary.toolCalls} tool calls</span>
            <span>{summary.payments} payment{summary.payments === 1 ? "" : "s"}</span>
            <span className={cn(summary.refusals > 0 && "text-blocked font-semibold")}>{summary.refusals} refusal{summary.refusals === 1 ? "" : "s"}</span>
            <span className="text-muted">{Math.round(summary.durationMs / 1000)} s</span>
          </div>
          <div className="mt-1">
            verdict <Badge variant={/CRITICAL|HIGH/.test(summary.verdict.severity) ? "blocked-solid" : summary.verdict.severity === "MEDIUM" ? "warn" : "allowed"}>{summary.verdict.severity}</Badge> <span className="text-muted">{summary.verdict.reasoning}</span>
          </div>
          {summary.purchase?.transactionId && (
            <div className="mt-1 text-xs">
              payment <Addr value={summary.purchase.transactionId} href={summary.purchase.explorer ?? CHAINS.hedera.tx(summary.purchase.transactionId)} head={12} tail={8} />
            </div>
          )}
        </div>
      )}
      {status === "failed" && (
        <div className="rounded-lg border border-warn bg-warn-soft p-3 text-sm" data-testid="failed">
          <span className="font-semibold">The run stopped:</span> {error ?? "unknown error"}. {entries.length} step{entries.length === 1 ? "" : "s"} completed above.
        </div>
      )}
      {status === "ended-early" && (
        <div className="rounded-lg border border-warn bg-warn-soft p-3 text-sm" data-testid="ended-early">
          <span className="font-semibold">Stream ended early</span>: {entries.length} step{entries.length === 1 ? "" : "s"} completed. The server stopped answering before the run finished (a serverless timeout looks like this); everything above is real and stays.
        </div>
      )}
    </div>
  );
}
