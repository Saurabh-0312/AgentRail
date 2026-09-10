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
          A directory that makes a service findable by other agents. Each name carries <code>rail.endpoint</code>, <code>rail.chain</code>, <code>rail.price</code>, <code>rail.token</code> and <code>rail.scheme</code>;{" "}
          <Link className="text-ens underline decoration-ens/50 underline-offset-2 hover:decoration-ens" href={`/agent/${agent}`}>{agent}</Link> resolves them and pays through its mandate, or is refused before a request is sent.
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
          <CardContent className="pt-4 text-sm text-muted space-y-2">
            <p>
              <span className="font-medium text-ink">How discovery works.</span> <code>discoverService(name)</code> walks the registries through ENSv2&apos;s UniversalResolver, reads the five records, and hands the agent a <code>{"{ chain, url, price, token }"}</code>. <code>rail.chain</code> selects the payment adapter. A missing or malformed record throws; there is no default URL to fall back to, because a default URL is exactly what discovery removes.
            </p>
            <p>
              <span className="font-medium text-ink">Discovery is not authorization.</span> The 402 challenge names a payee; the agent checks it against <code>rail.allowed</code> on its own name before anything is signed, and the on-chain mandate checks it again. That is why <span className="mono">{PUBLIC.rogueName}</span> resolves perfectly well and is refused every time.
            </p>
          </CardContent>
        </Card>
      </Reveal>
    </div>
  );
}
