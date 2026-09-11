/**
 * The server's one tail reader: the committed snapshot's cursor as the starting slot, the
 * snapshot's own create rows as the PDA -> ens_node index, and a cache in front of the public RPC.
 * A page render waits at most `waitMs` for a first read; past that it renders with the tail marked
 * `loading` while the read finishes in the background, and the Refresh button collects it.
 */
import "server-only";

import { Connection } from "@solana/web3.js";

import { serverEnv } from "./env";
import { loadSolanaSnapshot } from "./solana-snapshot";
import { cachedTail, pdaIndex, type TailResult } from "./solana-tail";

const reader = cachedTail(45_000, 15_000);
let index: Map<string, string> | null = null;

export async function solanaTail(force = false, waitMs = 12_000): Promise<TailResult> {
  const snap = loadSolanaSnapshot();
  index ??= pdaIndex(snap.rows);
  const connection = new Connection(serverEnv.solanaRpc(), "confirmed");
  const read = reader(connection, { sinceSlot: snap.nextBlock, ensNodeOfPda: (pda) => index!.get(pda) ?? null }, force);
  const timeout = new Promise<TailResult>((resolve) => setTimeout(() => resolve({ fromSlot: snap.nextBlock, throughSlot: snap.nextBlock - 1, fetchedAt: new Date().toISOString(), signatures: 0, rows: [], loading: true, error: "the live tail is still being read" }), waitMs));
  return Promise.race([read, timeout]);
}
