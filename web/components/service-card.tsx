import Link from "next/link";

import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { ChainBadge } from "@/components/chain-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hederaLongZeroAddress } from "@agentrail/sdk/src/tails/hedera.ts";

import { CHAINS, ENS_APP_URL, chainFromCaip } from "@/lib/chains";
import type { ServiceEntry } from "@/lib/services";

/** A service as the agent discovers it: five records, read from ENS, nothing configured. */
export function ServiceCard({ s, agentName }: { s: ServiceEntry; agentName: string }) {
  const r = s.records;
  const chainKey = r["rail.chain"] ? chainFromCaip(r["rail.chain"]) : null;
  const meta = chainKey ? CHAINS[chainKey] : null;
  const rogue = s.onAllowList === false;
  // the account the payment actually lands in: what the endpoint names, else the payee this chain permits
  const payee = s.payee ?? s.allowedOnChain[0]?.target ?? null;
  // Hedera names accounts 0.0.x; the mandate stores the EVM long-zero form, which is what an owner pastes
  const payeeEvm = chainKey === "hedera" && payee && /^\d+\.\d+\.\d+$/.test(payee) ? hederaLongZeroAddress(payee) : null;
  return (
    <Card accent={rogue ? "blocked" : (meta?.color ?? "ens")} interactive className="flex h-full flex-col">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">
            <a href={ENS_APP_URL(s.name)} target="_blank" rel="noreferrer" className="hover:underline decoration-ens/60 underline-offset-4">{s.name}</a>
          </CardTitle>
          {chainKey && <ChainBadge chain={chainKey} />}
          <Badge variant="ens" title="every field below was read from the name's resolver on this request">resolved from ENS</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rogue ? <Badge variant="blocked" size="lg">ROGUE · payee not on the allow-list</Badge> : s.onAllowList === null ? <Badge variant="neutral">payee checked at purchase (402)</Badge> : <Badge variant="allowed">payee allowed</Badge>}
        </div>
        {r.description && <CardDescription>{r.description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm flex-1 flex flex-col">
        <div className="rounded-lg border border-border bg-surface-sunken/70 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">price</div>
          <div className="mt-0.5 text-lg font-semibold tnum">
            {chainKey ? <Amount chain={chainKey} units={r["rail.price"]} /> : r["rail.price"]} <span className="text-xs font-normal text-muted">{chainKey === "base" ? "per query" : "per symbol"}</span>
          </div>
        </div>
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted">rail.endpoint</dt>
          <dd className="mono break-all text-xs"><a className="underline decoration-border underline-offset-2 hover:decoration-ink" href={r["rail.endpoint"]} target="_blank" rel="noreferrer">{r["rail.endpoint"]}</a></dd>
          <dt className="text-muted">rail.chain</dt>
          <dd className="mono text-xs">{r["rail.chain"]}</dd>
          <dt className="text-muted">rail.token</dt>
          <dd>{meta && r["rail.token"] ? <Addr value={r["rail.token"]} href={chainKey === "hedera" ? `https://hashscan.io/testnet/token/${r["rail.token"]}` : meta.address(r["rail.token"])} /> : <span className="mono text-xs">{r["rail.token"]}</span>}</dd>
          <dt className="text-muted">rail.scheme</dt>
          <dd className="mono text-xs">{r["rail.scheme"]}</dd>
          {payee && (
            <>
              <dt className="text-muted">payee</dt>
              <dd>
                <Addr
                  value={payeeEvm ?? payee}
                  href={chainKey === "hedera" ? `https://hashscan.io/testnet/account/${payee}` : (meta?.address(payee) ?? undefined)}
                  full
                  className="break-all text-xs"
                />
              </dd>
            </>
          )}
        </dl>
        <div className="mt-auto rounded-lg border border-border bg-surface-sunken/70 p-3 text-xs space-y-1">
          <div className="text-muted">Five ENS records; nothing configured.</div>
          {s.payee && (
            <div>
              Payee <Addr value={s.payee} href={meta ? meta.address(s.payee) : undefined} />{" "}
              {rogue ? (
                <span className="text-blocked">
                  is not on <Link className="underline" href={`/agent/${agentName}`}>{agentName}</Link>&apos;s allow-list: refused <code>NotOnAllowList</code> before any request. <Link className="underline" href="/activity?show=blocked">Blocked feed</Link>.
                </span>
              ) : (
                <span className="text-allowed">is on the allow-list.</span>
              )}
            </div>
          )}
          {!s.payee && (
            <div>
              Payee comes in the 402; {agentName} permits {s.allowedOnChain.length} on {chainKey ? CHAINS[chainKey].short : r["rail.chain"]}
              {s.allowedOnChain.length > 0 && (
                <>
                  : {s.allowedOnChain.map((a) => (
                    <span key={a.target} className="inline-flex flex-wrap items-center gap-1">
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
              . Others refused before any request.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
