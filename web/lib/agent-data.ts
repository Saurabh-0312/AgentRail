/**
 * Everything the agent page and /api/mandate/[name] share: the name resolved through ENSv2, the
 * live mandate on each chain it names, and the Solana lifecycle (creates and revokes) from the
 * snapshot as proof that the mandate really is revocable.
 */
import "server-only";

import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";
import { namehash } from "viem/ens";

import { resolveName, type ResolvedName } from "./ens";
import { PUBLIC, serverEnv } from "./env";
import { readEvmMandate, readSolanaMandate, solanaPda, type LiveMandate, type SolanaDelegation } from "./mandate-live";
import { loadSolanaSnapshot } from "./solana-snapshot";

export interface MandatePayload extends ResolvedName {
  ensNode: string | null;
  /** Agent names: the mandate on each chain, read live. */
  live?: { solana?: LiveMandate & { delegation?: SolanaDelegation }; hedera?: LiveMandate; base?: LiveMandate };
  contracts: { registry: string; resolver: string; identityRegistry: string; evmMandate: string; solanaProgram: string; universalResolver: string };
}

export function safeNamehash(name: string): string | null {
  try {
    return namehash(name);
  } catch {
    return null;
  }
}

export async function getMandatePayload(rawName: string): Promise<MandatePayload> {
  const readText = sepoliaEnsReader(serverEnv.sepoliaRpc());
  const resolved = await resolveName(rawName, readText);
  const payload: MandatePayload = {
    ...resolved,
    ensNode: safeNamehash(resolved.name),
    contracts: {
      registry: PUBLIC.registry,
      resolver: PUBLIC.resolver,
      identityRegistry: PUBLIC.identityRegistry,
      evmMandate: PUBLIC.evmMandate,
      solanaProgram: PUBLIC.solanaProgram,
      universalResolver: "0x85edf8b6b7d4211e2b07aa687506b746357b92cf",
    },
  };
  if (resolved.kind === "agent") {
    const r = resolved.records;
    const solanaAgent = r["rail.agent.solana"] ?? null;
    const pda = r["rail.mandate.pda"] ?? (solanaAgent ? solanaPda(PUBLIC.solanaOwner, solanaAgent) : null);
    const [solana, hedera, base] = await Promise.all([
      pda ? readSolanaMandate(pda, solanaAgent) : Promise.resolve(undefined),
      r["rail.agent.hedera"] ? readEvmMandate("hedera", r["rail.agent.hedera"] as `0x${string}`) : Promise.resolve(undefined),
      r["rail.agent.base"] ? readEvmMandate("base", r["rail.agent.base"] as `0x${string}`) : Promise.resolve(undefined),
    ]);
    payload.live = { solana, hedera, base };
  }
  return payload;
}

export interface LifecycleTx {
  kind: "create_mandate" | "revoke_mandate";
  txHash: string;
  timestamp: number;
  slot: number;
}

/** Every create and revoke of this mandate on Solana, from the snapshot, newest first. */
export function solanaLifecycle(ensNode: string): LifecycleTx[] {
  const node = ensNode.toLowerCase();
  return loadSolanaSnapshot()
    .rows.filter((r) => r.entity === "Mandate" && String(r.data.ensNode ?? "").toLowerCase() === node && (r.data.kind === "create_mandate" || r.data.kind === "revoke_mandate") && typeof r.data.txHash === "string")
    .map((r) => ({ kind: r.data.kind as LifecycleTx["kind"], txHash: String(r.data.txHash), timestamp: Number(r.data.timestamp ?? 0), slot: Number(r.data.slot ?? r.block) }))
    .sort((a, b) => b.slot - a.slot);
}
