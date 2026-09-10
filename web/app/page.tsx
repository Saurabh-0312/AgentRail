import Link from "next/link";

import { Lookup } from "@/components/lookup";
import { StatusStrip } from "@/components/status-strip";
import { PUBLIC } from "@/lib/env";

/**
 * The page a stranger lands on. One sentence, one input, three examples, and a live status strip.
 * Gate 6: paste a name and understand what the agent may do.
 */
export default function Home() {
  return (
    <div className="space-y-8">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">AgentRail</h1>
        <p className="mt-2 text-lg text-ink">
          An AI agent&apos;s permissions, published as an ENS name and enforced on chain, so the agent cannot do what it was not authorized to do, even when it is tricked.
        </p>
        <p className="mt-2 text-sm text-muted">
          Paste an agent&apos;s name to see who it works for, what it may buy, from whom, with what caps, and every time it was refused.
        </p>
      </div>

      <Lookup
        examples={[
          { name: PUBLIC.agentName, hint: "the agent" },
          { name: PUBLIC.serviceNames[0] ?? "feed.agentrail.eth", hint: "a shop it may pay" },
          { name: PUBLIC.rogueName, hint: "a shop it may not" },
        ]}
      />

      <StatusStrip />

      <div className="grid gap-4 sm:grid-cols-3 text-sm">
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">The name is the mandate</div>
          <p className="mt-1 text-muted">An expiring, revocable, non-transferable ENSv2 subname carries the agent&apos;s keys and the rules it may spend under. Only the owner can write them.</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">The chain is the gate</div>
          <p className="mt-1 text-muted">The agent holds no spending key. It asks; a program on Solana, Hedera or Base checks the destination, the instruction and the caps, and signs or refuses.</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">The refusals are the record</div>
          <p className="mt-1 text-muted">
            Every attempt, allowed or blocked, is indexed under the name. <Link className="text-ens underline" href="/activity?show=blocked">See the blocked ones</Link> or <Link className="text-ens underline" href="/attack">how a real model was tricked and stopped</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
