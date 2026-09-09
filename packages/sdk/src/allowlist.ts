/**
 * Discovery is not authorization. `rail.allowed` on the agent's own ENS name is the list of payees
 * its mandate permits; a discovered service must match it before any payment step runs.
 */
import type { DiscoveredService } from "./discovery.ts";
import { DiscoveryError } from "./discovery.ts";

/** The `rail.allowed` record on the agent's own name: what its mandate lets it buy. */
export interface AllowedEntry {
  chain: string;
  /** The payee the mandate permits: Solana token account, Hedera account id, or EVM address. */
  target: string;
  perTx?: string;
  total?: string;
  mint?: string;
  instructions?: string[];
}

export function parseAllowed(raw: string | null | undefined, agentName: string): AllowedEntry[] {
  if (!raw?.trim()) throw new DiscoveryError(agentName, "rail.allowed", "is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DiscoveryError(agentName, "rail.allowed", "is not JSON");
  }
  if (!Array.isArray(parsed)) throw new DiscoveryError(agentName, "rail.allowed", "must be a JSON array");
  return parsed.map((e, i) => {
    if (!e || typeof e !== "object" || typeof e.chain !== "string" || typeof e.target !== "string") {
      throw new DiscoveryError(agentName, "rail.allowed", `entry ${i} needs chain and target`);
    }
    return e as AllowedEntry;
  });
}

/** Discovery is not authorization: the discovered payee must be on the agent's own allow-list. */
export class NotOnAllowList extends Error {
  readonly service: string;
  readonly chain: string;
  readonly payTo: string;
  constructor(service: string, chain: string, payTo: string) {
    super(`${service} resolves to ${payTo} on ${chain}, which is not on the mandate's rail.allowed list`);
    this.name = "NotOnAllowList";
    this.service = service;
    this.chain = chain;
    this.payTo = payTo;
  }
}

export function assertAllowed(allowed: AllowedEntry[], service: DiscoveredService, payTo: string): AllowedEntry {
  const hit = allowed.find((e) => e.chain === service.chain && e.target.toLowerCase() === payTo.toLowerCase());
  if (!hit) throw new NotOnAllowList(service.name, service.chain, payTo);
  return hit;
}
