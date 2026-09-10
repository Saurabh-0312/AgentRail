import Link from "next/link";

import { Lookup } from "@/components/lookup";
import { Reveal } from "@/components/motion";
import { StatusStrip } from "@/components/status-strip";
import { Card, CardContent } from "@/components/ui/card";
import { PUBLIC } from "@/lib/env";

/**
 * The page a stranger lands on. One sentence, one input, three examples, and a live status strip.
 * Gate 6: paste a name and understand what the agent may do.
 */
export default function Home() {
  return (
    <div className="space-y-8">
      <Reveal index={0} className="max-w-3xl space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Instruction-level authorization for AI agents</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">AgentRail</h1>
        <p className="text-lg text-ink sm:text-xl">
          An AI agent&apos;s permissions, published as an ENS name and enforced on chain, so the agent cannot do what it was not authorized to do, even when it is tricked.
        </p>
        <p className="text-sm text-muted">Paste an agent&apos;s name to see who it works for, what it may buy, from whom, with what caps, and every time it was refused.</p>
      </Reveal>

      <Reveal index={1}>
        <Lookup
          examples={[
            { name: PUBLIC.agentName, hint: "the agent" },
            { name: PUBLIC.serviceNames[0] ?? "feed.agentrail.eth", hint: "a shop it may pay" },
            { name: PUBLIC.rogueName, hint: "a shop it may not" },
          ]}
        />
      </Reveal>

      <Reveal index={2}>
        <StatusStrip />
      </Reveal>

      <Reveal index={3} className="grid gap-4 sm:grid-cols-3 text-sm">
        <Card accent="ens" interactive>
          <CardContent className="pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-ens">The name is the mandate</div>
            <p className="mt-1.5 text-muted">An expiring, revocable, non-transferable ENSv2 subname carries the agent&apos;s keys and the rules it may spend under. Only the owner can write them.</p>
          </CardContent>
        </Card>
        <Card accent="solana" interactive>
          <CardContent className="pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-solana">The chain is the gate</div>
            <p className="mt-1.5 text-muted">The agent holds no spending key. It asks; a program on Solana, Hedera or Base checks the destination, the instruction and the caps, and signs or refuses.</p>
          </CardContent>
        </Card>
        <Card accent="blocked" interactive>
          <CardContent className="pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-blocked">The refusals are the record</div>
            <p className="mt-1.5 text-muted">
              Every attempt, allowed or blocked, is indexed under the name. <Link className="text-ens underline decoration-ens/50 underline-offset-2 hover:decoration-ens" href="/activity?show=blocked">See the blocked ones</Link> or{" "}
              <Link className="text-ens underline decoration-ens/50 underline-offset-2 hover:decoration-ens" href="/attack">how a real model was tricked and stopped</Link>.
            </p>
          </CardContent>
        </Card>
      </Reveal>
    </div>
  );
}
