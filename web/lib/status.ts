/**
 * A real health dot per chain: one cheap read each, timed, from the server. Plus the index heads in
 * Studio and whether the live x402 feed is awake (Render's free tier sleeps). Nothing here is a
 * static "all systems go".
 */
import "server-only";

import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";
import { EVM_MANDATE_ABI } from "@agentrail/sdk/src/evm/abi.ts";
import { hederaTestnet } from "@agentrail/sdk/src/evm/clients.ts";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia, sepolia } from "viem/chains";

import { PUBLIC, serverEnv } from "./env";
import { redact } from "./redact";

export interface StatusEntry {
  key: string;
  label: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface StatusPayload {
  at: string;
  chains: StatusEntry[];
  feed: StatusEntry & { sleeping: boolean };
  index: StatusEntry[];
}

async function timed(key: string, label: string, fn: () => Promise<string>, timeoutMs = 8000): Promise<StatusEntry> {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([fn(), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return { key, label, ok: true, latencyMs: Date.now() - t0, detail };
  } catch (e) {
    return { key, label, ok: false, latencyMs: Date.now() - t0, detail: redact(e instanceof Error ? e.message.split("\n")[0] : String(e)).slice(0, 200) };
  }
}

async function studioHead(url: string, apiKey: string): Promise<string> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query: "{ _meta { block { number } hasIndexingErrors } }" }) });
  const j = (await res.json()) as { data?: { _meta?: { block?: { number: number }; hasIndexingErrors?: boolean } } };
  const b = j.data?._meta?.block?.number;
  if (b === undefined) throw new Error("no _meta");
  return `head block ${b}${j.data?._meta?.hasIndexingErrors ? ", indexing errors" : ""}`;
}

export async function getStatus(): Promise<StatusPayload> {
  const [sep, bas, hed, sol, feed, idxSep, idxBase] = await Promise.all([
    timed("sepolia", "ENS · Sepolia", async () => {
      const client = createPublicClient({ chain: sepolia, transport: http(serverEnv.sepoliaRpc()) });
      const block = await client.getBlockNumber();
      const v = await sepoliaEnsReader(serverEnv.sepoliaRpc())(PUBLIC.agentName, "rail.version");
      return `block ${block}, ${PUBLIC.agentName} rail.version=${v ?? "unset"}`;
    }),
    timed("base", "Base Sepolia", async () => {
      const client = createPublicClient({ chain: baseSepolia, transport: http(serverEnv.baseRpc()) });
      const block = await client.getBlockNumber();
      const id = await client.readContract({ address: PUBLIC.evmMandate as Address, abi: EVM_MANDATE_ABI, functionName: "mandateIdFor", args: [PUBLIC.owner as Address, "0x6FB563E9Af8a1011f846842793d73bA12AA91875"] });
      const [, , , , active] = await client.readContract({ address: PUBLIC.evmMandate as Address, abi: EVM_MANDATE_ABI, functionName: "getMandate", args: [id] });
      return `block ${block}, EvmMandate ${active ? "active" : "no active mandate"}`;
    }),
    timed("hedera", "Hedera testnet", async () => {
      const client = createPublicClient({ chain: hederaTestnet, transport: http(serverEnv.hederaRpc()) });
      const block = await client.getBlockNumber();
      return `block ${block} (JSON-RPC relay; mirror may lag consensus)`;
    }),
    timed("solana", "Solana devnet", async () => {
      const connection = new Connection(serverEnv.solanaRpc(), "confirmed");
      const slot = await connection.getSlot();
      const info = await connection.getAccountInfo(new PublicKey(PUBLIC.solanaProgram));
      return `slot ${slot}, program ${info?.executable ? "deployed" : "MISSING"}`;
    }),
    timed(
      "feed",
      "x402 feed (Render)",
      async () => {
        const res = await fetch(`${PUBLIC.feedUrl}/health`, { signal: AbortSignal.timeout(7000) });
        return `${res.status} ${res.ok ? "awake" : "unhealthy"}`;
      },
      7500,
    ),
    timed("index-sepolia", "Studio · Sepolia subgraph", () => studioHead(serverEnv.subgraphSepolia(), serverEnv.graphApiKey())),
    timed("index-base", "Studio · Base subgraph", () => studioHead(serverEnv.subgraphBase(), serverEnv.graphApiKey())),
  ]);
  return { at: new Date().toISOString(), chains: [sep, bas, hed, sol], feed: { ...feed, sleeping: !feed.ok && /timeout|abort/i.test(feed.detail) }, index: [idxSep, idxBase] };
}
