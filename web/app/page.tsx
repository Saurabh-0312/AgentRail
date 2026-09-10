import Link from "next/link";

/** Replaced by the public lookup page in the next step; until then, the routes that exist. */
export default function Home() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AgentRail</h1>
        <p className="mt-1 text-muted">Instruction-level authorization for AI agents. A mandate is published as an ENS name and enforced on chain.</p>
      </div>
      <ul className="text-sm space-y-1">
        <li><Link className="text-ens underline" href="/agent/databot.agentrail.eth">/agent/databot.agentrail.eth</Link></li>
        <li><Link className="text-ens underline" href="/activity">/activity</Link></li>
        <li><Link className="text-ens underline" href="/services">/services</Link></li>
        <li><Link className="text-ens underline" href="/attack">/attack</Link></li>
      </ul>
    </div>
  );
}
