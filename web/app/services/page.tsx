import Link from "next/link";

import { Reveal } from "@/components/motion";
import { ServiceCard } from "@/components/service-card";
import { Card, CardContent } from "@/components/ui/card";
import { PUBLIC } from "@/lib/env";
import { isoDate } from "@/lib/format";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Services have ENS names too. The agent starts with a name and nothing else, reads five records,
 * and knows where to pay, on which chain and how much. No URL and no API key appear anywhere in
 * the agent's demo path; everything on this page was read from the resolver just now.
 */
export default async function ServicesPage() {
  const { agent, resolvedAt, services } = await getServices();
  return (
    <div className="space-y-6">
      <Reveal index={0} className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">Services</h1>
        <p className="mt-1 text-sm text-muted">
          Services other agents can find by name: endpoint, chain, price, token and scheme as ENS records.{" "}
          <Link className="text-ens underline decoration-ens/50 underline-offset-2 hover:decoration-ens" href={`/agent/${agent}`}>{agent}</Link> pays them through its mandate, or is refused.
        </p>
        <p className="mt-1 text-xs text-muted tnum">Resolved from ENSv2 on Sepolia at {isoDate(Math.floor(Date.parse(resolvedAt) / 1000))}, on this request.</p>
      </Reveal>

      <div className="grid gap-4 xl:grid-cols-3">
        {services.map((s, i) => (
          <Reveal key={s.name} index={i + 1}>
            {s.kind === "service" ? (
              <ServiceCard s={s} agentName={agent} />
            ) : (
              <Card accent="warn">
                <CardContent className="pt-4 text-sm">
                  <span className="mono">{s.name}</span> did not resolve as a service{s.error ? `: ${s.error}` : ""}.
                </CardContent>
              </Card>
            )}
          </Reveal>
        ))}
      </div>

      <Reveal index={services.length + 1}>
        <Card>
          <CardContent className="pt-4 text-sm text-muted">
            <p>
              <span className="font-medium text-ink">Discovery:</span> <code>discoverService(name)</code> reads the five ENS records and returns <code>{"{ chain, url, price, token }"}</code>; no default URL. <span className="font-medium text-ink">Not authorization:</span> the 402 payee is checked against <code>rail.allowed</code> before signing and by the mandate on chain, so <span className="mono">{PUBLIC.rogueName}</span> resolves and is refused every time.
            </p>
          </CardContent>
        </Card>
      </Reveal>
    </div>
  );
}
