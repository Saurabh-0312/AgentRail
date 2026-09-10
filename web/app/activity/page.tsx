import Link from "next/link";

import { ActivityFeed } from "@/components/activity-feed";
import { Addr } from "@/components/addr";
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted">
          One query, three chains, for mandate <Addr value={ensNode} head={10} tail={6} />
          {ensNode === PUBLIC.ensNode && (<> (<Link className="text-ens underline" href={`/agent/${PUBLIC.agentName}`}>{PUBLIC.agentName}</Link>)</>)}.
          A refusal on Solana is a landed, failed transaction, so it is a row like any other.
        </p>
      </div>

      {error && (
        <Card accent="blocked">
          <CardContent className="pt-4 text-sm text-blocked">The index could not be read: {error}</CardContent>
        </Card>
      )}

      {payload && (
        <>
          <Card>
            <CardContent className="pt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="tnum"><span className="text-xl font-semibold">{payload.summary.actions}</span> actions</span>
              <span className="tnum text-blocked"><span className="text-xl font-semibold">{payload.summary.blocked}</span> blocked</span>
              <span className="tnum text-muted">across <span className="font-semibold text-ink">{payload.summary.chains}</span> chains</span>
              <span className="flex flex-wrap gap-1.5">
                {Object.entries(payload.summary.blockedByCode)
                  .sort((a, b) => b[1] - a[1])
                  .map(([code, n]) => (
                    <span key={code} className="rounded border border-blocked/30 bg-blocked-soft px-1.5 py-0.5 text-xs text-blocked tnum">
                      {code} {errorName(Number(code)) ?? ""} ×{n}
                    </span>
                  ))}
              </span>
            </CardContent>
            <CardContent className="pb-4 text-xs text-muted flex flex-wrap gap-x-6 gap-y-1">
              {payload.sources.map((s) => (
                <span key={s.chain}>
                  <span className="font-medium text-ink">{s.chain}</span> {s.error ? <span className="text-blocked">error: {s.error.slice(0, 80)}</span> : `${s.actions} action${s.actions === 1 ? "" : "s"}`}
                  {s.chain === "solana" ? ` · snapshot of the Substreams stream, synced ${isoDate(Math.floor(Date.parse(payload.solana.syncedAt) / 1000))}, next block ${payload.solana.nextBlock}` : " · live from Subgraph Studio"}
                </span>
              ))}
            </CardContent>
          </Card>

          <ActivityFeed rows={payload.feed} initialMode={initialMode} />
        </>
      )}
    </div>
  );
}
