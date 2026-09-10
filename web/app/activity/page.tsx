import Link from "next/link";

import { ActivityFeed } from "@/components/activity-feed";
import { Addr } from "@/components/addr";
import { CountUp } from "@/components/count-up";
import { Reveal } from "@/components/motion";
import { Card, CardContent } from "@/components/ui/card";
import { errorName } from "@/lib/chains";
import { PUBLIC } from "@/lib/env";
import type { FeedMode } from "@/lib/feed";
import { isoDate } from "@/lib/format";
import { history } from "@/lib/history";

export const dynamic = "force-dynamic";

/**
 * /activity?ensNode=0x…&show=blocked
 *
 * Everything one mandate did, on every chain it exists on, newest first. The blocked rows are the
 * product: this page exists so a judge cannot miss them.
 */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ ensNode?: string; show?: string }> }) {
  const sp = await searchParams;
  const ensNode = sp.ensNode && /^0x[0-9a-fA-F]{64}$/.test(sp.ensNode) ? sp.ensNode : PUBLIC.ensNode;
  const initialMode: FeedMode = sp.show === "blocked" || sp.show === "allowed" ? sp.show : "all";
  let payload: Awaited<ReturnType<typeof history>> | null = null;
  let error: string | null = null;
  try {
    payload = await history(ensNode);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <Reveal index={0}>
        <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted">
          One query, three chains, for mandate <Addr value={ensNode} head={10} tail={6} />
          {ensNode === PUBLIC.ensNode && (<> (<Link className="text-ens underline decoration-ens/50 underline-offset-2 hover:decoration-ens" href={`/agent/${PUBLIC.agentName}`}>{PUBLIC.agentName}</Link>)</>)}.
          A refusal on Solana is a landed, failed transaction, so it is a row like any other.
        </p>
      </Reveal>

      {error && (
        <Reveal index={1}>
          <Card accent="blocked">
            <CardContent className="pt-4 text-sm text-blocked">The index could not be read: {error}</CardContent>
          </Card>
        </Reveal>
      )}

      {payload && (
        <>
          <Reveal index={1}>
            <Card>
              <CardContent className="pt-4 grid gap-4 sm:grid-cols-[auto_auto_auto_1fr] sm:items-center">
                <div className="tnum">
                  <CountUp value={payload.summary.actions} className="block text-3xl font-semibold leading-none" />
                  <div className="mt-1 text-xs uppercase tracking-wide text-muted">actions</div>
                </div>
                <div className="tnum text-blocked">
                  <CountUp value={payload.summary.blocked} className="block text-3xl font-semibold leading-none" />
                  <div className="mt-1 text-xs uppercase tracking-wide">blocked</div>
                </div>
                <div className="tnum">
                  <span className="block text-3xl font-semibold leading-none">{payload.summary.chains}</span>
                  <div className="mt-1 text-xs uppercase tracking-wide text-muted">chains</div>
                </div>
                <div className="flex flex-wrap gap-1.5 sm:justify-end">
                  {Object.entries(payload.summary.blockedByCode)
                    .sort((a, b) => b[1] - a[1])
                    .map(([code, n]) => (
                      <Link key={code} href={`/activity?ensNode=${ensNode}&show=blocked`} className="rounded-md border border-blocked/40 bg-blocked-soft px-2 py-1 text-xs text-blocked tnum hover:border-blocked">
                        <span className="font-semibold">{code}</span> {errorName(Number(code)) ?? ""} <span className="text-muted">×{n}</span>
                      </Link>
                    ))}
                </div>
              </CardContent>
              <CardContent className="pb-4 text-xs text-muted flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3">
                {payload.sources.map((s) => (
                  <span key={s.chain}>
                    <span className="font-medium text-ink">{s.chain}</span> {s.error ? <span className="text-blocked">error: {s.error.slice(0, 80)}</span> : `${s.actions} action${s.actions === 1 ? "" : "s"}`}
                    {s.chain === "solana" ? ` · snapshot of the Substreams stream, synced ${isoDate(Math.floor(Date.parse(payload.solana.syncedAt) / 1000))}, next block ${payload.solana.nextBlock}` : " · live from Subgraph Studio"}
                  </span>
                ))}
              </CardContent>
            </Card>
          </Reveal>

          <Reveal index={2}>
            <ActivityFeed rows={payload.feed} initialMode={initialMode} dense sticky />
          </Reveal>
        </>
      )}
    </div>
  );
}
