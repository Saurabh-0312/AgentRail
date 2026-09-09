/**
 * ENS discovery (SPEC §7.4, §8.3.4). The agent starts with a name and nothing else.
 *
 *   discoverService("feed.agentrail.eth")  ->  { chain, url, price, token, scheme }
 *
 * The five `rail.*` records are read through ENSv2's UniversalResolver on Sepolia: the resolver
 * is found by walking the registries (agentrail.eth -> AgentRailRegistry -> feed), never by a
 * hardcoded address. A missing or malformed record throws; there is no default URL to fall back
 * to, because a default URL is exactly what this phase removes.
 */
import type { ChainId, ServiceRef } from "./types.ts";
import { X402_NETWORK } from "./types.ts";

/** Reads one ENS text record. Injected: viem's `getEnsText` in production, a map in tests. */
export type EnsTextReader = (name: string, key: string) => Promise<string | null | undefined>;

export interface DiscoveredService extends ServiceRef {
  name: string;
  /** Base units per unit of service, from `rail.price`. */
  price: bigint;
  /** Asset id on `chain`: HTS token id, ERC-20 address, or SPL mint. */
  token: string;
  scheme: "x402";
  description?: string;
  /** Every record as read, for display. */
  records: Record<string, string>;
}

export class DiscoveryError extends Error {
  readonly name_: string;
  readonly key: string;
  constructor(name: string, key: string, message: string) {
    super(`${name}: ${key} ${message}`);
    this.name = "DiscoveryError";
    this.name_ = name;
    this.key = key;
  }
}

export const RAIL_KEYS = ["rail.endpoint", "rail.chain", "rail.price", "rail.token", "rail.scheme"] as const;

const KNOWN_CHAINS = new Set<string>(Object.keys(X402_NETWORK));

export async function discoverService(name: string, readText: EnsTextReader): Promise<DiscoveredService> {
  const records: Record<string, string> = {};
  for (const key of RAIL_KEYS) {
    const value = (await readText(name, key))?.trim();
    if (!value) throw new DiscoveryError(name, key, "is missing");
    records[key] = value;
  }
  const description = (await readText(name, "description"))?.trim();
  if (description) records.description = description;

  const endpoint = records["rail.endpoint"];
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DiscoveryError(name, "rail.endpoint", `is not a URL: ${endpoint}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DiscoveryError(name, "rail.endpoint", `has unsupported scheme ${url.protocol}`);
  }

  const chain = records["rail.chain"];
  if (!KNOWN_CHAINS.has(chain)) {
    throw new DiscoveryError(name, "rail.chain", `is not a chain this SDK has an adapter for: ${chain}`);
  }

  if (!/^\d+$/.test(records["rail.price"])) {
    throw new DiscoveryError(name, "rail.price", `must be an integer in base units: ${records["rail.price"]}`);
  }
  const price = BigInt(records["rail.price"]);

  if (records["rail.scheme"] !== "x402") {
    throw new DiscoveryError(name, "rail.scheme", `unsupported: ${records["rail.scheme"]}`);
  }

  return {
    name,
    chain: chain as ChainId,
    url: endpoint,
    price,
    token: records["rail.token"],
    scheme: "x402",
    description,
    records,
  };
}
