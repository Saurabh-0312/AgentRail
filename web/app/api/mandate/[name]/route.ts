/**
 * GET /api/mandate/<ens name>
 *
 * Resolves a name through ENSv2 on Sepolia, classifies it (agent, service, unknown) from the
 * records that came back, and for an agent reads the live mandate on every chain it names. Works
 * for any name; an unknown one returns an honest empty shape, not an error.
 */
import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";
import { namehash } from "viem/ens";

import { PUBLIC, serverEnv } from "@/lib/env";
import { resolveName } from "@/lib/ens";
import { readEvmMandate, readSolanaMandate, solanaPda, type LiveMandate, type SolanaDelegation } from "@/lib/mandate-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface MandatePayload {
  name: string;
  ensNode: string | null;
  kind: "agent" | "service" | "unknown";
  records: Record<string, string>;
  allowed?: unknown[];
  service?: unknown;
  error?: string;
  /** Agent names: the mandate on each chain, read live. */
  live?: { solana?: LiveMandate & { delegation?: SolanaDelegation }; hedera?: LiveMandate; base?: LiveMandate };
  contracts: { registry: string; resolver: string; identityRegistry: string; evmMandate: string; solanaProgram: string };
}

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const readText = sepoliaEnsReader(serverEnv.sepoliaRpc());
  const resolved = await resolveName(decodeURIComponent(name), readText);
  let ensNode: string | null = null;
  try {
    ensNode = namehash(resolved.name);
  } catch {
    ensNode = null;
  }
  const payload: MandatePayload = {
    ...resolved,
    ensNode,
    contracts: { registry: PUBLIC.registry, resolver: PUBLIC.resolver, identityRegistry: PUBLIC.identityRegistry, evmMandate: PUBLIC.evmMandate, solanaProgram: PUBLIC.solanaProgram },
  };

  if (resolved.kind === "agent") {
    const r = resolved.records;
    const solanaAgent = r["rail.agent.solana"] ?? null;
    const pda = r["rail.mandate.pda"] ?? (solanaAgent ? solanaPda(PUBLIC.solanaOwner, solanaAgent) : null);
    const [sol, hed, bas] = await Promise.all([
      pda ? readSolanaMandate(pda, solanaAgent) : Promise.resolve(undefined),
      r["rail.agent.hedera"] ? readEvmMandate("hedera", r["rail.agent.hedera"] as `0x${string}`) : Promise.resolve(undefined),
      r["rail.agent.base"] ? readEvmMandate("base", r["rail.agent.base"] as `0x${string}`) : Promise.resolve(undefined),
    ]);
    payload.live = { solana: sol, hedera: hed, base: bas };
  }
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
