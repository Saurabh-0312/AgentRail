import Link from "next/link";

import { ActivateAgent, type BudgetLine } from "@/components/activate-agent";
import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { ChainBadge } from "@/components/chain-badge";
import { CountUp } from "@/components/count-up";
import { Countdown } from "@/components/countdown";
import { FundingPanel } from "@/components/funding";
import { Reveal } from "@/components/motion";
import { OwnerActions } from "@/components/owner-actions";
import { ServiceCard } from "@/components/service-card";
import { SpendBar } from "@/components/spend-bar";
import { StatusPill, statusOf } from "@/components/status-pill";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getMandatePayload, solanaLifecycle, type MandatePayload } from "@/lib/agent-data";
import { CHAINS, ENS_APP_URL, type ChainKey } from "@/lib/chains";
import { requiredAllowance } from "@/lib/delegation";
import { cn } from "@/lib/cn";
import { PUBLIC } from "@/lib/env";
import { isoDate } from "@/lib/format";
import { history, type HistoryPayload } from "@/lib/history";
import type { LiveMandate, SolanaDelegation } from "@/lib/mandate-live";
import { getService } from "@/lib/services";
import { SPL_TOKEN_PROGRAM, describeInstruction, hederaAccountFromLongZero } from "@/lib/spl";
import { chainKeyFromCaip } from "@/lib/units";

export const dynamic = "force-dynamic";

/** The chains a mandate is enforced on; Sepolia holds the name, not a spend gate. */
const LIVE_CHAINS = ["solana", "hedera", "base"] as const;

function Section({ title, hint, tone, id, children }: { title: string; hint?: string; tone?: "blocked" | "agent"; id?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 scroll-mt-20" id={id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className={cn("inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide", tone === "blocked" ? "text-blocked" : tone === "agent" ? "text-agent" : "text-muted")}>
          {tone === "blocked" && <i className="inline-block size-2 rounded-full bg-blocked" aria-hidden />}
          {tone === "agent" && <i className="inline-block size-2 rounded-full bg-agent" aria-hidden />}
          {title}
        </h2>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-1.5 text-sm border-t border-border first:border-t-0">
      <div className="text-muted">{k}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function PermissionCard({ chain, m }: { chain: ChainKey; m: (LiveMandate & { delegation?: SolanaDelegation }) | undefined }) {
  const meta = CHAINS[chain];
  if (!m) {
    return (
      <Card accent={meta.color}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ChainBadge chain={chain} /> not named
          </CardTitle>
          <CardDescription>The name carries no agent key for this chain, so there is no mandate to read.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const status = statusOf(m);
  return (
    <Card accent={meta.color} className="flex flex-col">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <ChainBadge chain={chain} />
        <StatusPill status={status} />
        {m.exists && m.expiry > 0 && (
          <span className="text-xs text-muted">
            <Countdown expiry={m.expiry} />
          </span>
        )}
        <span className="ml-auto text-xs text-muted">
          {chain === "solana" ? "PDA" : "mandate"} <Addr value={m.id} href={chain === "solana" ? meta.address(m.id) : meta.address(m.contract)} />
        </span>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        {m.error && <p className="text-xs text-blocked">read failed: {m.error}</p>}
        {!m.exists && !m.error && <p className="text-sm text-muted">No mandate exists on this chain for this agent right now.</p>}
        {m.permissions.length === 0 && m.exists && <p className="text-sm text-muted">Mandate exists but permits nothing yet.</p>}
        {m.permissions.map((p) => {
          const isInstructionKeyed = chain === "solana" && p.target === SPL_TOKEN_PROGRAM;
          const hederaId = chain === "hedera" ? hederaAccountFromLongZero(p.target) : null;
          return (
            <div key={p.target} className="rounded-lg border border-border bg-surface-sunken/70 p-3 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {isInstructionKeyed ? (
                  <>
                    <Badge variant="solana">verify</Badge>
                    <span>SPL Token program, instructions:</span>
                    {p.instructions.length ? p.instructions.map((i) => <Badge key={i} variant="neutral">{describeInstruction(i)}</Badge>) : <Badge variant="blocked">none</Badge>}
                  </>
                ) : (
                  <>
                    <Badge variant={meta.color}>{chain === "solana" ? "execute_payment" : "authorize"}</Badge>
                    <span>to</span>
                    <Addr value={hederaId ?? p.target} href={hederaId ? meta.address(hederaId) : meta.address(p.target)} />
                    {hederaId && <span className="text-xs text-muted">(stored as {p.target.slice(0, 10)}…)</span>}
                  </>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs tnum sm:grid-cols-3">
                <div>
                  <div className="text-muted">per transaction</div>
                  <div className="font-medium text-sm">{p.perTx === "0" ? "no cap" : <Amount chain={chain} units={p.perTx} secondary="below" />}</div>
                </div>
                <div>
                  <div className="text-muted">lifetime</div>
                  <div className="font-medium text-sm">{p.total === "0" ? "no cap" : <Amount chain={chain} units={p.total} secondary="below" />}</div>
                </div>
                {p.callCount !== null && (
                  <div>
                    <div className="text-muted">calls</div>
                    <div className="font-medium text-sm">{p.callCount}</div>
                  </div>
                )}
              </div>
              <SpendBar spent={p.spent} cap={p.total} chain={chain} />
            </div>
          );
        })}
        {chain === "solana" && m.delegation && <DelegationRow d={m.delegation} />}
        {chain !== "solana" && m.exists && <FundingPanel chain={chain} funding={m.funding} active={m.active} error={m.fundingError} />}
        <p className="text-[11px] text-muted">read {isoDate(Math.floor(Date.parse(m.readAt) / 1000))}</p>
      </CardContent>
    </Card>
  );
}

function DelegationRow({ d }: { d: SolanaDelegation }) {
  return (
    <div className="rounded-lg border border-border bg-surface-sunken/70 p-3 text-sm space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">Alice&apos;s USDC account</span>
        <Addr value={d.account} href={CHAINS.solana.address(d.account)} />
        <Amount chain="solana" units={d.balance} secondary="tooltip" className="font-medium" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">delegate</span>
        {d.delegate ? <Addr value={d.delegate} href={CHAINS.solana.address(d.delegate)} /> : <span>none</span>}
        {d.delegate && (d.delegateIsMandate ? <Badge variant="allowed">the mandate PDA</Badge> : <Badge variant="blocked">NOT the mandate</Badge>)}
      </div>
      <p className="text-xs text-muted">Tokens stay here; only the program can make the PDA sign.</p>
    </div>
  );
}

function UnknownName({ payload }: { payload: MandatePayload }) {
  return (
    <Reveal className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{payload.name}</h1>
      <Card accent="warn">
        <CardHeader>
          <CardTitle>No AgentRail records on this name</CardTitle>
          <CardDescription>
            {payload.error ? `Resolution failed: ${payload.error}` : `Resolved through ENSv2 on Sepolia; none of the rail.* records an agent or a service carries were found.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted space-y-2">
          <p>
            An agent name carries <code>rail.allowed</code>, <code>rail.agent.*</code> and <code>rail.mandate.pda</code>. A service name carries <code>rail.endpoint</code>, <code>rail.chain</code>, <code>rail.price</code>, <code>rail.token</code> and <code>rail.scheme</code>.
          </p>
          <p>
            Try <Link className="text-ens underline" href="/agent/databot.agentrail.eth">databot.agentrail.eth</Link>.
          </p>
        </CardContent>
      </Card>
    </Reveal>
  );
}

export default async function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const payload = await getMandatePayload(decodeURIComponent(name));
  if (payload.kind === "service") {
    const entry = await getService(payload);
    return (
      <Reveal className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{payload.name}</h1>
        <p className="text-sm text-muted">
          A service name, not an agent: something an agent can discover and pay. All three are in the <Link className="text-ens underline" href="/services">directory</Link>.
        </p>
        <ServiceCard s={entry} agentName={PUBLIC.agentName} />
      </Reveal>
    );
  }
  if (payload.kind !== "agent") return <UnknownName payload={payload} />;

  const r = payload.records;
  const live = payload.live ?? {};
  const hist: HistoryPayload | null = payload.ensNode ? await history(payload.ensNode).catch(() => null) : null;
  const ensMandate = hist?.mandates.find((m) => m.chain === "sepolia");
  const lifecycle = payload.ensNode ? solanaLifecycle(payload.ensNode) : [];
  const revokes = lifecycle.filter((l) => l.kind === "revoke_mandate");
  const overall = [live.solana, live.hedera, live.base].filter(Boolean).map((m) => statusOf(m));
  const erc = r["rail.erc8004"]?.split(":");
  /** What each chain's caps still permit, before the run spends any of it. */
  const budget: BudgetLine[] = LIVE_CHAINS.flatMap((c) => {
    const m = live[c];
    if (!m) return [];
    const perTx = m.permissions.map((p) => p.perTx).filter((x) => x !== "0").sort((a, b) => Number(a) - Number(b))[0] ?? null;
    return [{ chain: c, active: statusOf(m) === "active", remaining: m.exists ? requiredAllowance(m.permissions) : "0", perTx }];
  }); // eip155:11155111:0x8004…:10190
  const owner = ensMandate?.owner ?? PUBLIC.owner;

  return (
    <div className="space-y-8">
      {/* 1. identity: who this is and whether it is working, before anything else */}
      <Reveal index={0} className="space-y-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight">
              <a href={ENS_APP_URL(payload.name)} target="_blank" rel="noreferrer" className="hover:underline decoration-ens/60 underline-offset-4">{payload.name}</a>
            </h1>
            <p className="mt-1 text-sm text-muted">
              An agent mandate, published as an ENSv2 subname and enforced on {overall.length} chain{overall.length === 1 ? "" : "s"}.
              {ensMandate && (<> The name itself <Countdown expiry={Number(ensMandate.expiry)} />.</>)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {LIVE_CHAINS.map((c) => live[c] && (
              <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs shadow-1">
                <ChainBadge chain={c} /> <StatusPill status={statusOf(live[c])} />
                {live[c]!.exists && live[c]!.expiry > 0 && <span className="text-muted"><Countdown expiry={live[c]!.expiry} /></span>}
              </span>
            ))}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card accent="ens" className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Identity</CardTitle>
            </CardHeader>
            <CardContent>
              <Row k="ENS node"><Addr value={payload.ensNode ?? ""} head={10} tail={6} /></Row>
              <Row k="owner"><Addr value={ensMandate?.owner ?? "—"} href={ensMandate?.owner ? CHAINS.sepolia.address(ensMandate.owner) : undefined} /> <span className="text-xs text-muted">Sepolia, holds the name in AgentRailRegistry</span></Row>
              <Row k="name expiry">
                {ensMandate ? (<><Countdown expiry={Number(ensMandate.expiry)} /> <span className="text-xs text-muted">({isoDate(Number(ensMandate.expiry))}, enforced by the registry)</span></>) : <span className="text-muted">not in the index yet</span>}
              </Row>
              <Row k="ERC-8004"><span>agent id <span className="font-medium">{erc?.[3] ?? "—"}</span></span> {erc && <Addr value={erc[2]} href={CHAINS.sepolia.address(erc[2])} className="ml-2" />}</Row>
              <Row k="agent · Solana">{r["rail.agent.solana"] ? <Addr value={r["rail.agent.solana"]} href={CHAINS.solana.address(r["rail.agent.solana"])} /> : "—"} <span className="text-xs text-muted">0 SOL, no authority, by design</span></Row>
              <Row k="agent · Hedera">{r["rail.agent.hedera"] ? <Addr value={r["rail.agent.hedera"]} href={CHAINS.hedera.address(r["rail.agent.hedera"])} /> : "—"}</Row>
              <Row k="agent · Base">{r["rail.agent.base"] ? <Addr value={r["rail.agent.base"]} href={CHAINS.base.address(r["rail.agent.base"])} /> : "—"}</Row>
              <Row k="status record">{r["rail.status"] ? <span className="mono text-xs">{r["rail.status"].slice(0, 80)}</span> : "—"} <span className="text-xs text-muted">the one record the agent may write</span></Row>
            </CardContent>
          </Card>

          <Card accent="ens">
            <CardHeader>
              <CardTitle>Properties</CardTitle>
              <CardDescription>Each one is ENS machinery, not a field we made up.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <div className="font-medium">Non-transferable</div>
                <div className="text-xs text-muted">AgentRailRegistry reverts every transfer (<code>TransferDisallowed</code>). <a className="underline" href={CHAINS.sepolia.address(payload.contracts.registry)} target="_blank" rel="noreferrer">registry</a></div>
              </div>
              <div>
                <div className="font-medium">Expiring</div>
                <div className="text-xs text-muted">The subname itself expires{ensMandate ? `, ${isoDate(Number(ensMandate.expiry))}` : ""}; each chain&apos;s mandate has its own expiry too.</div>
              </div>
              <div>
                <div className="font-medium">Revocable</div>
                <div className="text-xs text-muted">
                  Independently on every chain, by the owner, below. On Solana, revoked {revokes.length} time{revokes.length === 1 ? "" : "s"} so far
                  {revokes[0] && (<>, latest <Addr value={revokes[0].txHash} href={CHAINS.solana.tx(revokes[0].txHash)} /></>)}.
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </Reveal>

      {/* 1b. run it: one click, one monitor pass, streamed live; not owner-gated, spends the owner's budget */}
      <Reveal index={1}>
        <Section id="run" title="Run it" tone="agent" hint="one click, one monitor pass, every step live; anyone may press it, the owner's budget pays">
          <ActivateAgent name={payload.name} wallet={PUBLIC.aliceWallet} feedService={PUBLIC.serviceNames.find((n) => n.startsWith("feed.")) ?? PUBLIC.serviceNames[0]} budget={budget} />
        </Section>
      </Reveal>

      {/* 2. the kill switch, before the detail: instant revocation is the claim */}
      <Reveal index={1}>
        <Section id="owner" title="Owner actions" tone="blocked" hint="need the owner's key; a visitor can see them, not press them">
          <OwnerActions
            owner={owner}
            agentName={payload.name}
            mandates={{
              ...(live.hedera && live.hedera.exists ? { hedera: { id: live.hedera.id, active: live.hedera.active, agent: live.hedera.agent, funding: live.hedera.funding } } : {}),
              ...(live.base && live.base.exists ? { base: { id: live.base.id, active: live.base.active, agent: live.base.agent, funding: live.base.funding } } : {}),
            }}
          />
        </Section>
      </Reveal>

      {/* 3. what it may do, live, with the ceiling it was issued from */}
      <Reveal index={2}>
        <Section id="permissions" title="What it may do" hint="read live from each chain; the mandate, not a mirror">
          <div className="grid gap-4 lg:grid-cols-3">
            <PermissionCard chain="solana" m={live.solana} />
            <PermissionCard chain="hedera" m={live.hedera} />
            <PermissionCard chain="base" m={live.base} />
          </div>
          <div className="space-y-2 pt-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">The published rules</h3>
              <span className="text-xs text-muted">rail.allowed on the name: the ceiling the owner published; mandates are issued from it and may be tighter</span>
            </div>
            {payload.allowed?.length ? (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent"><TH>chain</TH><TH>payee</TH><TH className="text-right">per tx</TH><TH className="text-right">lifetime</TH><TH>instructions</TH></TR>
                </THead>
                <TBody>
                  {payload.allowed.map((a, i) => {
                    const chain = chainKeyFromCaip(a.chain);
                    return (
                      <TR key={i}>
                        <TD>{chain ? <ChainBadge chain={chain} /> : a.chain}</TD>
                        <TD><Addr value={a.target} href={chain ? CHAINS[chain].address(a.target) : undefined} /></TD>
                        <TD className="text-right tnum">{a.perTx && chain ? <Amount chain={chain} units={a.perTx} secondary="below" className="items-end" /> : (a.perTx ?? "—")}</TD>
                        <TD className="text-right tnum">{a.total && chain ? <Amount chain={chain} units={a.total} secondary="below" className="items-end" /> : (a.total ?? "—")}</TD>
                        <TD className="text-xs">{a.instructions?.length ? a.instructions.join(", ") : <span className="text-muted">payments only</span>}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No rail.allowed record.</p>
            )}
          </div>
        </Section>
      </Reveal>

      {/* 4. the records themselves */}
      <Reveal index={3}>
        <Section id="records" title="Raw records" hint="as read from the resolver through UniversalResolverV2">
          <Table dense>
            <THead>
              <TR className="hover:bg-transparent"><TH>key</TH><TH>value</TH></TR>
            </THead>
            <TBody>
              {Object.entries(r).map(([k, v]) => (
                <TR key={k}>
                  <TD className="mono whitespace-nowrap">{k}</TD>
                  <TD className="mono break-all text-xs">{v}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="text-xs text-muted">
            resolver <Addr value={payload.contracts.resolver} href={CHAINS.sepolia.address(payload.contracts.resolver)} /> · universal resolver <Addr value={payload.contracts.universalResolver} href={CHAINS.sepolia.address(payload.contracts.universalResolver)} />
          </p>
        </Section>
      </Reveal>

      {/* 5. what it did, in numbers, and the feed itself */}
      {hist && (
        <Reveal index={4}>
          <Section id="activity" title="Activity" hint="from the shared index">
            <Card>
              <CardContent className="pt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="tnum"><CountUp value={hist.summary.actions} className="text-xl font-semibold" /> actions</span>
                <span className="tnum text-blocked"><CountUp value={hist.summary.blocked} className="text-xl font-semibold" /> blocked</span>
                <span className="tnum text-muted">across <span className="font-semibold text-ink">{hist.summary.chains}</span> chains</span>
                {hist.summary.blocked > 0 && (
                  <Link href={`/activity?ensNode=${payload.ensNode}&show=blocked`} className="text-sm text-blocked underline decoration-blocked/50 underline-offset-2 hover:decoration-blocked">
                    see the refusals
                  </Link>
                )}
                <Link href={`/activity?ensNode=${payload.ensNode}`} className="ml-auto rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink shadow-1 hover:border-border-strong hover:bg-muted-soft">
                  open the full feed →
                </Link>
              </CardContent>
            </Card>
          </Section>
        </Reveal>
      )}
    </div>
  );
}
