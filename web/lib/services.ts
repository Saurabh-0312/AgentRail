/**
 * The service directory: names resolved from ENS on every request, annotated with what the demo
 * agent's own allow-list says about paying on that chain. A service whose endpoint bakes in a payee
 * that is not on the list is marked from the data, not from its name.
 */
import "server-only";

import type { AllowedEntry } from "@agentrail/sdk/src/allowlist.ts";
import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";

import { payeeInEndpoint, resolveName, type ResolvedName } from "./ens";
import { PUBLIC, serverEnv } from "./env";

export interface ServiceEntry extends ResolvedName {
  /** The payee the endpoint itself names, when it does (our feed's demo route). */
  payee: string | null;
  /** Payees the agent's rail.allowed permits on this service's chain. */
  allowedOnChain: { target: string; perTx?: string; total?: string }[];
  /** null = only known at purchase time (from the 402); false = the endpoint's payee is not listed. */
  onAllowList: boolean | null;
}

export function annotateService(s: ResolvedName, agentAllowed: AllowedEntry[]): ServiceEntry {
  const chain = s.records["rail.chain"];
  const payee = s.records["rail.endpoint"] ? payeeInEndpoint(s.records["rail.endpoint"]) : null;
  const allowedOnChain = agentAllowed.filter((a) => a.chain === chain).map((a) => ({ target: a.target, perTx: a.perTx, total: a.total }));
  const onAllowList = payee ? allowedOnChain.some((a) => a.target.toLowerCase() === payee.toLowerCase()) : null;
  return { ...s, payee, allowedOnChain, onAllowList };
}

export async function getServices(): Promise<{ agent: string; resolvedAt: string; services: ServiceEntry[] }> {
  const readText = sepoliaEnsReader(serverEnv.sepoliaRpc());
  const names = [...PUBLIC.serviceNames, PUBLIC.rogueName];
  const [agent, ...resolved] = await Promise.all([PUBLIC.agentName, ...names].map((n) => resolveName(n, readText)));
  return { agent: PUBLIC.agentName, resolvedAt: new Date().toISOString(), services: resolved.map((s) => annotateService(s, agent.allowed ?? [])) };
}

/** One service, annotated against the demo agent's allow-list (for a service name pasted into the lookup). */
export async function getService(resolved: ResolvedName): Promise<ServiceEntry> {
  const readText = sepoliaEnsReader(serverEnv.sepoliaRpc());
  const agent = await resolveName(PUBLIC.agentName, readText);
  return annotateService(resolved, agent.allowed ?? []);
}
