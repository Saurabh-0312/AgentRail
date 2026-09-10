import Link from "next/link";

import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { ChainBadge } from "@/components/chain-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CHAINS, ENS_APP_URL, chainFromCaip } from "@/lib/chains";
import type { ServiceEntry } from "@/lib/services";

/** A service as the agent discovers it: five records, read from ENS, nothing configured. */
export function ServiceCard({ s, agentName }: { s: ServiceEntry; agentName: string }) {
  const r = s.records;
  const chainKey = r["rail.chain"] ? chainFromCaip(r["rail.chain"]) : null;
  const meta = chainKey ? CHAINS[chainKey] : null;
  const rogue = s.onAllowList === false;
  return (
    <Card accent={rogue ? "blocked" : (meta?.color ?? "ens")}>
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="text-base">
          <a href={ENS_APP_URL(s.name)} target="_blank" rel="noreferrer" className="hover:underline">{s.name}</a>
        </CardTitle>
        {chainKey && <ChainBadge chain={chainKey} />}
        {rogue ? <Badge variant="blocked">payee not on the allow-list</Badge> : s.onAllowList === null ? <Badge variant="neutral">payee checked at purchase (402)</Badge> : <Badge variant="allowed">payee allowed</Badge>}
        {r.description && <CardDescription className="basis-full">{r.description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted">rail.endpoint</dt>
          <dd className="mono break-all text-xs"><a className="underline decoration-border hover:decoration-ink" href={r["rail.endpoint"]} target="_blank" rel="noreferrer">{r["rail.endpoint"]}</a></dd>
          <dt className="text-muted">rail.chain</dt>
          <dd className="mono text-xs">{r["rail.chain"]}</dd>
          <dt className="text-muted">rail.price</dt>
          <dd className="tnum">
            {chainKey ? <Amount chain={chainKey} units={r["rail.price"]} /> : r["rail.price"]} <span className="text-xs text-muted">{chainKey === "base" ? "per query" : "per symbol"}</span>
          </dd>
          <dt className="text-muted">rail.token</dt>
          <dd>{meta && r["rail.token"] ? <Addr value={r["rail.token"]} href={chainKey === "hedera" ? `https://hashscan.io/testnet/token/${r["rail.token"]}` : meta.address(r["rail.token"])} /> : <span className="mono text-xs">{r["rail.token"]}</span>}</dd>
          <dt className="text-muted">rail.scheme</dt>
          <dd className="mono text-xs">{r["rail.scheme"]}</dd>
        </dl>
        <div className="rounded-md border border-border bg-muted-soft/60 p-3 text-xs space-y-1">
          <div className="text-muted">
            Resolved from ENS, not configured: the agent reads these five records and knows where to pay, on what chain, how much.
          </div>
          {s.payee && (
            <div>
              This endpoint names its payee itself: <Addr value={s.payee} href={meta ? meta.address(s.payee) : undefined} />{" "}
              {rogue ? (
                <span className="text-blocked">
                  which <Link className="underline" href={`/agent/${agentName}`}>{agentName}</Link>&apos;s allow-list does not permit — every purchase is refused <code>NotOnAllowList</code> before a request is sent. See it in the <Link className="underline" href="/activity?show=blocked">blocked feed</Link>.
                </span>
              ) : (
                <span className="text-allowed">which is on the allow-list.</span>
              )}
            </div>
          )}
          {!s.payee && (
            <div>
              The payee arrives in the 402 challenge; {agentName} permits {s.allowedOnChain.length} payee{s.allowedOnChain.length === 1 ? "" : "s"} on {chainKey ? CHAINS[chainKey].short : r["rail.chain"]}
              {s.allowedOnChain.length > 0 && (
                <>
                  : {s.allowedOnChain.map((a) => (
                    <span key={a.target} className="inline-flex items-center gap-1">
                      <Addr value={a.target} href={meta ? meta.address(a.target) : undefined} />
                      {a.perTx && a.total && chainKey && (
                        <span className="text-muted tnum">
                          (<Amount chain={chainKey} units={a.perTx} secondary="tooltip" /> per tx, <Amount chain={chainKey} units={a.total} secondary="tooltip" /> lifetime)
                        </span>
                      )}
                    </span>
                  ))}
                </>
              )}
              . Anything else is refused before a request is sent.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
