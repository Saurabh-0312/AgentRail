/**
 * ENS resolution, on the server, through ENSv2's UniversalResolver on Sepolia (the SDK's reader).
 * A name is read for the `rail.*` records an agent carries and the ones a service carries, and
 * classified from what came back. Nothing is hardcoded about any name: `rogue.agentrail.eth` is
 * marked rogue because its endpoint names a payee that is not on the agent's allow-list, not
 * because the app knows its name.
 */
import { parseAllowed, type AllowedEntry } from "@agentrail/sdk/src/allowlist.ts";
import { discoverService, type DiscoveredService, type EnsTextReader } from "@agentrail/sdk/src/discovery.ts";

export const AGENT_KEYS = ["rail.version", "rail.agent.solana", "rail.agent.hedera", "rail.agent.base", "rail.erc8004", "rail.mandate.pda", "rail.allowed", "rail.status"] as const;
export const SERVICE_KEYS = ["rail.endpoint", "rail.chain", "rail.price", "rail.token", "rail.scheme", "description"] as const;

export type NameKind = "agent" | "service" | "unknown";

export interface ResolvedName {
  name: string;
  kind: NameKind;
  /** Every record that resolved, as read. */
  records: Record<string, string>;
  /** Agent names: the parsed allow-list. */
  allowed?: AllowedEntry[];
  /** Service names: the discovered service. */
  service?: Omit<DiscoveredService, "price"> & { price: string };
  /** Why classification failed, when it did. */
  error?: string;
}

export function normalizeName(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function looksLikeName(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name);
}

/** Classify from records alone; pure, so it is unit-tested without a chain. */
export function classify(name: string, records: Record<string, string>): ResolvedName {
  if (records["rail.endpoint"] && records["rail.chain"]) return { name, kind: "service", records };
  if (records["rail.allowed"] || records["rail.mandate.pda"] || records["rail.agent.solana"]) return { name, kind: "agent", records };
  return { name, kind: "unknown", records };
}

export async function resolveName(rawName: string, readText: EnsTextReader): Promise<ResolvedName> {
  const name = normalizeName(rawName);
  if (!looksLikeName(name)) return { name, kind: "unknown", records: {}, error: "not a valid ENS name" };
  const records: Record<string, string> = {};
  try {
    // every record is one eth_call through the UniversalResolver; read them all at once
    const keys = [...AGENT_KEYS, ...SERVICE_KEYS];
    const values = await Promise.all(keys.map((key) => readText(name, key)));
    keys.forEach((key, i) => {
      const v = values[i]?.trim();
      if (v) records[key] = v;
    });
  } catch (e) {
    return { name, kind: "unknown", records, error: e instanceof Error ? e.message : String(e) };
  }
  const resolved = classify(name, records);
  if (resolved.kind === "agent" && records["rail.allowed"]) {
    try {
      resolved.allowed = parseAllowed(records["rail.allowed"], name);
    } catch (e) {
      resolved.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (resolved.kind === "service") {
    try {
      const s = await discoverService(name, async (n, k) => records[k] ?? null);
      resolved.service = { ...s, price: s.price.toString() };
    } catch (e) {
      resolved.error = e instanceof Error ? e.message : String(e);
    }
  }
  return resolved;
}

/** A service whose 402 payee is baked into its endpoint (our own feed's demo route does this). */
export function payeeInEndpoint(url: string): string | null {
  try {
    return new URL(url).searchParams.get("payTo");
  } catch {
    return null;
  }
}
