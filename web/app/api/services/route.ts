/**
 * GET /api/services
 *
 * The service directory, resolved from ENS on every request: each name's `rail.*` records, which
 * chain it settles on, and whether the demo agent's own allow-list permits a payee on that chain.
 * A service whose endpoint bakes in a payee that is not on the list is marked as such, from the
 * data, not from its name.
 */
import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";

import { PUBLIC, serverEnv } from "@/lib/env";
import { payeeInEndpoint, resolveName, type ResolvedName } from "@/lib/ens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ServiceEntry extends ResolvedName {
  /** The payee the endpoint itself names, when it does (our feed's demo route). */
  payee: string | null;
  /** Payees the agent's rail.allowed permits on this service's chain. */
  allowedOnChain: { target: string; perTx?: string; total?: string }[];
  /** null = only known at purchase time (from the 402); false = the endpoint's payee is not listed. */
  onAllowList: boolean | null;
}

export async function GET() {
  const readText = sepoliaEnsReader(serverEnv.sepoliaRpc());
  const names = [...PUBLIC.serviceNames, PUBLIC.rogueName];
  const [agent, ...resolved] = await Promise.all([PUBLIC.agentName, ...names].map((n) => resolveName(n, readText)));
  const services: ServiceEntry[] = [];
  for (const s of resolved) {
    const chain = s.records["rail.chain"];
    const payee = s.records["rail.endpoint"] ? payeeInEndpoint(s.records["rail.endpoint"]) : null;
    const allowedOnChain = (agent.allowed ?? []).filter((a) => a.chain === chain).map((a) => ({ target: a.target, perTx: a.perTx, total: a.total }));
    const onAllowList = payee ? allowedOnChain.some((a) => a.target.toLowerCase() === payee.toLowerCase()) : null;
    services.push({ ...s, payee, allowedOnChain, onAllowList });
  }
  return Response.json({ agent: PUBLIC.agentName, resolvedAt: new Date().toISOString(), services }, { headers: { "Cache-Control": "no-store" } });
}
