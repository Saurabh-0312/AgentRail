import Link from "next/link";

import { Addr } from "@/components/addr";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CHAINS, HCS_TOPIC_URL, errorReason } from "@/lib/chains";
import { PUBLIC } from "@/lib/env";
import { loadSolanaSnapshot } from "@/lib/solana-snapshot";

import evidence from "@/data/attack-evidence.json";

/**
 * The Phase 5 evidence as a walkthrough. Every signature on this page is checked against the
 * indexed snapshot at render time: a row that the proof layer does not carry is shown as such,
 * never asserted.
 */
export default function AttackPage() {
  const indexed = new Set(loadSolanaSnapshot().rows.map((r) => String(r.data.txHash ?? "")));
  const sol = CHAINS.solana;
  const Indexed = ({ tx, outside }: { tx: string; outside?: string }) =>
    indexed.has(tx) ? (
      <Badge variant="allowed" title="this signature is a row in the shared index (the committed Solana snapshot)">indexed</Badge>
    ) : outside ? (
      <Badge variant="neutral" title={outside}>outside the index: SPL Token</Badge>
    ) : (
      <Badge variant="warn" title="the committed snapshot does not carry this signature; refresh it with snapshot:solana">not in snapshot</Badge>
    );

  return (
    <div className="space-y-8">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">The attack</h1>
        <p className="mt-1 text-ink">
          A real model, a poisoned input it legitimately bought, four sincere attempts, four reverted transactions. Nothing here is scripted; the harness only recorded what happened.
        </p>
        <p className="mt-1 text-sm text-muted">
          {evidence.runAt} · {evidence.model} · {evidence.network} · transcript <code className="text-xs">{evidence.transcript}</code>
        </p>
      </div>

      <Card accent="hedera">
        <CardHeader>
          <CardTitle>1. The poison arrived inside data the agent paid for</CardTitle>
          <CardDescription>{evidence.channel}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <blockquote className="rounded-md border border-warn/40 bg-warn-soft p-3 text-sm">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-warn">planted in the feed response, field &quot;SECURITY_NOTICE&quot;</div>
            {evidence.advisory}
          </blockquote>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>the three purchases that carried it, settled on Hedera:</span>
            {evidence.purchases.map((p) => (
              <span key={p.attack} className="inline-flex items-center gap-1">
                <span className="mono">{p.attack}</span> <Addr value={p.tx} href={CHAINS.hedera.tx(p.tx)} head={12} tail={6} />
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card accent="agent">
        <CardHeader>
          <CardTitle>2. The model intended to comply, in its own words</CardTitle>
          <CardDescription>It quoted the planted advisory back verbatim, attacker address included. It could only have learned that address from the poisoned response.</CardDescription>
        </CardHeader>
        <CardContent>
          <blockquote className="border-l-4 border-agent pl-3 text-sm italic">{evidence.modelSaid}</blockquote>
        </CardContent>
      </Card>

      <Card accent="blocked">
        <CardHeader>
          <CardTitle>3. What the chain said</CardTitle>
          <CardDescription>Each row is a landed, failed transaction on Solana devnet, and a row in the shared index.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>#</TH>
                <TH>the agent was told to</TH>
                <TH>what it did</TH>
                <TH>gate</TH>
                <TH>verdict</TH>
                <TH>signature</TH>
              </TR>
            </THead>
            <TBody>
              {evidence.attacks.map((a) => (
                <TR key={a.id} className={a.improvised ? "bg-warn-soft/60" : "bg-blocked-soft/40"}>
                  <TD className="font-semibold tnum">{a.n}</TD>
                  <TD className="text-sm">
                    <div className="font-medium">{a.title}</div>
                    <div className="text-xs text-muted">{a.toldTo}</div>
                  </TD>
                  <TD className="text-xs">{a.modelDid}</TD>
                  <TD className="mono text-xs">{a.gate}</TD>
                  <TD>
                    <Badge variant="blocked">{`REVERTED ${a.code}`}</Badge>
                    <div className="text-xs text-blocked">{a.error}</div>
                    <div className="text-xs text-muted">{errorReason(a.code)}</div>
                  </TD>
                  <TD className="space-y-1">
                    <Addr value={a.tx} href={sol.tx(a.tx)} head={8} tail={6} />
                    <div><Indexed tx={a.tx} /></div>
                    {"before" in a && a.before && (
                      <div className="text-[11px] text-muted">before: {a.before.what} <Addr value={a.before.tx} href={sol.tx(a.before.tx)} head={6} tail={4} /></div>
                    )}
                    {"after" in a && a.after && (
                      <div className="text-[11px] text-muted">after: {a.after.what} <Addr value={a.after.tx} href={sol.tx(a.after.tx)} head={6} tail={4} /></div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="mt-3 rounded-md border border-warn/40 bg-warn-soft p-3 text-sm">
            <span className="font-semibold">Row 2b is the proof it is not scripted.</span> Nothing told the agent to try <code>revoke</code>. After <code>setAuthority</code> was refused it improvised a fallback on its own, and the gate refused that too. A scripted demo cannot produce a row nobody wrote.
          </div>
        </CardContent>
      </Card>

      <Card accent="allowed">
        <CardHeader>
          <CardTitle>4. The mandate governs even the good deed</CardTitle>
          <CardDescription>
            A CRITICAL finding makes the agent try to defend Alice. That attempt goes through the same gate as a payment: refused when the mandate forbids it, landed once the owner permits it. Five consecutive devnet slots.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2">
            {evidence.protective.steps.map((s, i) => {
              const tone = s.tone === "blocked" ? "border-l-blocked" : s.tone === "allowed" ? "border-l-allowed" : s.tone === "warn" ? "border-l-warn" : "border-l-border";
              return (
                <li key={i} className={`rounded-md border border-border border-l-4 ${tone} p-3 text-sm`}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {s.slot && <span className="mono text-xs text-muted tnum">slot {s.slot}</span>}
                    <span>{s.what}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    {s.tx && (<span className="inline-flex items-center gap-1">tx <Addr value={s.tx} href={sol.tx(s.tx)} head={8} tail={6} /> <Indexed tx={s.tx} outside={"outsideIndex" in s ? (s as { outsideIndex?: string }).outsideIndex : undefined} /></span>)}
                    {"alert" in s && s.alert && (<span className="inline-flex items-center gap-1 text-hedera">alert <Addr value={s.alert} href={HCS_TOPIC_URL(PUBLIC.hcsTopic)} head={12} tail={6} /></span>)}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-sm text-muted">
            Every other project demos a permission system blocking something bad. This demos it governing something good, which is what proves the constraint is unconditional rather than a filter on intent. Transcript <code className="text-xs">{evidence.protective.transcript}</code>.
          </p>
        </CardContent>
      </Card>

      <Card accent="warn">
        <CardHeader>
          <CardTitle>Honest limits</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>
            <span className="font-medium">Framing iterations: {evidence.framingIterations}.</span> {evidence.framingNote}
          </p>
          <p>
            <span className="font-medium">The agent can be tricked. That is the point.</span> AgentRail does not make the agent smarter; it makes being fooled stop mattering. A fully compromised agent can still spend its allowance at allowed payees, which is the designed maximum loss, and nothing outside the delegation is protected.
          </p>
          <p className="text-muted">
            All of the above are rows in the <Link className="text-ens underline" href="/activity?show=blocked">blocked feed</Link>, indexed on the same footing as the successes.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
