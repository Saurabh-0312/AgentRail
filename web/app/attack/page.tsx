import Link from "next/link";

import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { Reveal } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CHAINS, HCS_TOPIC_URL, errorReason } from "@/lib/chains";
import { cn } from "@/lib/cn";
import { PUBLIC } from "@/lib/env";
import { loadSolanaSnapshot } from "@/lib/solana-snapshot";

import evidence from "@/data/attack-evidence.json";

type Step = (typeof evidence.protective.steps)[number];

const TONE_BORDER: Record<string, string> = { blocked: "border-l-blocked", allowed: "border-l-allowed", warn: "border-l-warn", neutral: "border-l-border-strong" };

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

  const StepItem = ({ s }: { s: Step }) => (
    <li className={cn("rounded-lg border border-border border-l-4 bg-surface p-3 text-sm shadow-1", TONE_BORDER[s.tone] ?? TONE_BORDER.neutral)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {s.slot && <span className="mono text-xs text-muted tnum">slot {s.slot}</span>}
        <span>{s.what}</span>
        {"amount" in s && s.amount && (
          <span className="text-xs text-muted">
            delegated <Amount chain="solana" units={s.amount} />
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {s.tx && (<span className="inline-flex items-center gap-1">tx <Addr value={s.tx} href={sol.tx(s.tx)} head={8} tail={6} /> <Indexed tx={s.tx} outside={"outsideIndex" in s ? (s as { outsideIndex?: string }).outsideIndex : undefined} /></span>)}
        {"alert" in s && s.alert && (<span className="inline-flex items-center gap-1 text-hedera">alert <Addr value={s.alert} href={HCS_TOPIC_URL(PUBLIC.hcsTopic)} head={12} tail={6} /></span>)}
      </div>
    </li>
  );

  const steps = evidence.protective.steps;
  const before = steps.slice(0, 2);
  const pivot = steps[2];
  const after = steps.slice(3);

  return (
    <div className="space-y-8">
      <Reveal index={0} className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blocked">Gate 5 evidence</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">The attack</h1>
        <p className="mt-2 text-lg text-ink">
          A real model, a poisoned input it legitimately bought, four sincere attempts, four reverted transactions. Nothing here is scripted; the harness only recorded what happened.
        </p>
        <p className="mt-1 text-sm text-muted">
          {evidence.runAt} · {evidence.model} · {evidence.network} · transcript <code className="text-xs">{evidence.transcript}</code>
        </p>
      </Reveal>

      <Reveal index={1}>
        <Card accent="hedera">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><StepNumber n="1" /> The poison arrived inside data the agent paid for</CardTitle>
            <CardDescription>{evidence.channel}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <blockquote className="rounded-lg border border-warn/40 bg-warn-soft p-4 text-sm leading-relaxed">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-warn">planted in the feed response, field &quot;SECURITY_NOTICE&quot;</div>
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
      </Reveal>

      <Reveal index={2}>
        <Card accent="agent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><StepNumber n="2" /> The model intended to comply, in its own words</CardTitle>
            <CardDescription>It quoted the planted advisory back verbatim, attacker address included. It could only have learned that address from the poisoned response.</CardDescription>
          </CardHeader>
          <CardContent>
            <figure className="relative rounded-lg border border-agent/30 bg-agent/5 p-5 pl-12">
              <span className="absolute left-4 top-2 select-none font-serif text-5xl leading-none text-agent/60" aria-hidden>&ldquo;</span>
              <blockquote className="text-base italic leading-relaxed">{evidence.modelSaid}</blockquote>
              <figcaption className="mt-2 text-xs text-muted">{evidence.model}, in the attack transcript, immediately after the poisoned purchase</figcaption>
            </figure>
          </CardContent>
        </Card>
      </Reveal>

      <Reveal index={3}>
        <Card accent="blocked">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><StepNumber n="3" /> What the chain said</CardTitle>
            <CardDescription>Four attempts in sequence. Each is a landed, failed transaction on Solana devnet, and a row in the shared index.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="relative space-y-3 before:absolute before:left-[1.15rem] before:top-2 before:bottom-2 before:w-px before:bg-border">
              {evidence.attacks.map((a) => (
                <li key={a.id} className={cn("relative ml-0 rounded-lg border border-border border-l-4 bg-surface p-4 pl-14 shadow-1", a.improvised ? "border-l-warn" : "border-l-blocked")}>
                  <span className={cn("absolute left-2.5 top-4 inline-flex size-7 items-center justify-center rounded-full text-xs font-bold text-ink-inverse shadow-1", a.improvised ? "bg-warn" : "bg-blocked")} aria-hidden>
                    {a.n}
                  </span>
                  <div className="grid gap-x-6 gap-y-3 lg:grid-cols-[1.4fr_1fr_1fr]">
                    <div className="space-y-1.5">
                      <div className="font-semibold">{a.title}</div>
                      <div className="text-xs text-muted"><span className="font-medium text-ink">told to:</span> {a.toldTo}</div>
                      <div className="text-xs text-muted">
                        <span className="font-medium text-ink">did:</span> {a.modelDid}
                        {"amount" in a && a.amount && (<> · <Amount chain="solana" units={a.amount} className="text-ink" /></>)}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="text-[11px] uppercase tracking-wide text-muted">gate · verdict</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="solana">{a.gate}</Badge>
                        <Badge variant="blocked" size="lg">{`REVERTED ${a.code}`}</Badge>
                      </div>
                      <div className="text-xs font-medium text-blocked">{a.error}</div>
                      <div className="text-xs text-muted">{errorReason(a.code)}</div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="text-[11px] uppercase tracking-wide text-muted">signature</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Addr value={a.tx} href={sol.tx(a.tx)} head={8} tail={6} />
                        <Indexed tx={a.tx} />
                      </div>
                      {"before" in a && a.before && (
                        <div className="text-[11px] text-muted">before: {a.before.what} <Addr value={a.before.tx} href={sol.tx(a.before.tx)} head={6} tail={4} /></div>
                      )}
                      {"after" in a && a.after && (
                        <div className="text-[11px] text-muted">after: {a.after.what} <Addr value={a.after.tx} href={sol.tx(a.after.tx)} head={6} tail={4} /></div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-4 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
              <span className="font-semibold">Row 2b is the proof it is not scripted.</span> Nothing told the agent to try <code>revoke</code>. After <code>setAuthority</code> was refused it improvised a fallback on its own, and the gate refused that too. A scripted demo cannot produce a row nobody wrote.
            </div>
          </CardContent>
        </Card>
      </Reveal>

      <Reveal index={4}>
        <Card accent="allowed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><StepNumber n="4" /> The mandate governs even the good deed</CardTitle>
            <CardDescription>
              A CRITICAL finding makes the agent try to defend Alice. That attempt goes through the same gate as a payment: refused when the mandate forbids it, landed once the owner permits it. Five consecutive devnet slots, the same code path both times.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch">
              <section className="space-y-2">
                <h3 className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-blocked">
                  <i className="inline-block size-2 rounded-full bg-blocked" aria-hidden /> Before · the mandate permits Transfer only
                </h3>
                <ol className="space-y-2">
                  {before.map((s, i) => <StepItem key={i} s={s} />)}
                </ol>
                <p className="text-xs text-muted">Outcome: <span className="font-medium text-blocked">refused</span>, nothing built, Alice warned.</p>
              </section>
              <div className="flex items-center justify-center lg:flex-col">
                <div className="rounded-full border border-border bg-surface-sunken px-3 py-2 text-center text-xs shadow-1">
                  <div className="font-medium">the owner widens the mandate</div>
                  <div className="mt-0.5 text-muted">to permit Revoke</div>
                  {pivot?.tx && (<div className="mt-1"><Addr value={pivot.tx} href={sol.tx(pivot.tx)} head={6} tail={4} /></div>)}
                  {pivot?.slot && <div className="mono mt-0.5 text-[11px] text-muted tnum">slot {pivot.slot}</div>}
                </div>
              </div>
              <section className="space-y-2">
                <h3 className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-allowed">
                  <i className="inline-block size-2 rounded-full bg-allowed" aria-hidden /> After · the mandate permits Revoke
                </h3>
                <ol className="space-y-2">
                  {after.map((s, i) => <StepItem key={i} s={s} />)}
                </ol>
                <p className="text-xs text-muted">Outcome: <span className="font-medium text-allowed">landed</span>, the drainer delegation is gone, Alice told.</p>
              </section>
            </div>
            <p className="mt-4 text-sm text-muted">
              Every other project demos a permission system blocking something bad. This demos it governing something good, which is what proves the constraint is unconditional rather than a filter on intent. Transcript <code className="text-xs">{evidence.protective.transcript}</code>.
            </p>
          </CardContent>
        </Card>
      </Reveal>

      <Reveal index={5}>
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
              All of the above are rows in the <Link className="text-ens underline decoration-ens/50 underline-offset-2 hover:decoration-ens" href="/activity?show=blocked">blocked feed</Link>, indexed on the same footing as the successes.
            </p>
          </CardContent>
        </Card>
      </Reveal>
    </div>
  );
}

function StepNumber({ n }: { n: string }) {
  return <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-ink-inverse">{n}</span>;
}
