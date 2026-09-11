/**
 * The live tail of the Solana leg: everything the AgentRail program did since the committed
 * snapshot's cursor, read from the public RPC (no binary, no key, no Graph provider) and decoded
 * into the same `SolanaRow` shape the Substreams sink writes, so the page merges the two with no
 * special-casing. Failed transactions are kept on purpose: `meta.err` is where 6006 / 6007 / 6008 /
 * 6016 live, and the refusals are the product. The Rust module in indexer/substreams stays the
 * source of truth for history; this mirrors its decode.rs for the recent window.
 */
import idl from "@agentrail/sdk/src/solana/agentrail.idl.json";
import type { SolanaRow } from "@agentrail/query/src/solana-sink.ts";
import type { Connection, VersionedTransactionResponse } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { ERROR_NAMES } from "./chains";

export const AGENTRAIL_PROGRAM = (idl as { address: string }).address;
const CHAIN = "solana";
const DISC: Record<string, string> = Object.fromEntries((idl as { instructions: { name: string; discriminator: number[] }[] }).instructions.map((i) => [Buffer.from(i.discriminator).toString("hex"), i.name]));

export type BlockReason = "OVER_BUDGET" | "NOT_PERMITTED" | "EXPIRED" | "REVOKED" | "FAILED";

/** Mirror of errors.rs `block_reason`. */
export function blockReason(code: number | null | undefined): BlockReason {
  switch (code) {
    case 6000:
      return "REVOKED";
    case 6001:
      return "EXPIRED";
    case 6007:
    case 6008:
      return "OVER_BUDGET";
    case 6005:
    case 6006:
    case 6009:
    case 6010:
    case 6015:
    case 6016:
    case 6017:
      return "NOT_PERMITTED";
    default:
      return "FAILED";
  }
}

export interface Failure {
  /** The instruction the runtime blamed, when the error is an InstructionError. */
  instructionIndex: number | null;
  /** The program's custom code, when the inner error is `Custom`. */
  customCode: number | null;
}

/** `meta.err` as the RPC returns it: `{ InstructionError: [index, { Custom: code }] }`, another shape, or null. */
export function parseErr(err: unknown): Failure | null {
  if (err === null || err === undefined) return null;
  if (typeof err === "object" && err !== null && "InstructionError" in err) {
    const [index, inner] = (err as { InstructionError: [number, unknown] }).InstructionError;
    const custom = typeof inner === "object" && inner !== null && "Custom" in inner ? Number((inner as { Custom: number }).Custom) : null;
    return { instructionIndex: Number(index), customCode: custom };
  }
  return { instructionIndex: null, customCode: null };
}

/** Anchor writes "Error Number: 6006" into the logs; the runtime's Custom code says the same, but the log is the fallback. */
export function errorNumberFromLogs(logs: string[] | null | undefined): number | null {
  for (const line of logs ?? []) {
    const m = line.match(/Error Number: (\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** One transaction, flattened to what the decoder needs; built from the RPC response or by a test. */
export interface TailTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  logMessages: string[];
  accountKeys: string[];
  instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
}

export function fromRpc(signature: string, tx: VersionedTransactionResponse): TailTx {
  const message = tx.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const accountKeys: string[] = [];
  for (let i = 0; i < keys.length; i++) accountKeys.push(keys.get(i)!.toBase58());
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    err: tx.meta?.err ?? null,
    logMessages: tx.meta?.logMessages ?? [],
    accountKeys,
    instructions: message.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: [...ix.accountKeyIndexes], data: ix.data })),
  };
}

const u64 = (d: Uint8Array, at: number): bigint | null => {
  if (d.length < at + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
};
const i64 = (d: Uint8Array, at: number): bigint | null => {
  const v = u64(d, at);
  return v === null ? null : BigInt.asIntN(64, v);
};
const hex0x = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const base58 = (b: Uint8Array) => new PublicKey(b).toBase58();

/**
 * Decode every top-level AgentRail instruction of the given transactions into snapshot-shaped rows,
 * oldest first. `ensNodeOfPda` resolves the join key for mandates created before the window; creates
 * inside the window teach it on the way (a two-pass read, so a revoke after a create still joins).
 */
export function decodeTail(txs: TailTx[], ensNodeOfPda: (pda: string) => string | null, program = AGENTRAIL_PROGRAM): SolanaRow[] {
  const learned = new Map<string, string>();
  const ordered = [...txs].sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
  // pass 1: what was created in the window
  for (const tx of ordered) {
    for (const ix of tx.instructions) {
      if (tx.accountKeys[ix.programIdIndex] !== program || ix.data.length < 40) continue;
      if (DISC[Buffer.from(ix.data.subarray(0, 8)).toString("hex")] !== "create_mandate") continue;
      const pda = tx.accountKeys[ix.accounts[0]];
      if (pda) learned.set(pda, hex0x(ix.data.subarray(8, 40)));
    }
  }
  const nodeOf = (pda: string) => learned.get(pda) ?? ensNodeOfPda(pda) ?? "";
  const rows: SolanaRow[] = [];
  for (const tx of ordered) {
    const failure = parseErr(tx.err);
    const logError = errorNumberFromLogs(tx.logMessages);
    const timestamp = String(tx.blockTime ?? 0);
    const slot = String(tx.slot);
    const account = (ix: TailTx["instructions"][number], position: number) => tx.accountKeys[ix.accounts[position]] ?? "";
    tx.instructions.forEach((ix, ixIndex) => {
      if (tx.accountKeys[ix.programIdIndex] !== program || ix.data.length < 8) return;
      const name = DISC[Buffer.from(ix.data.subarray(0, 8)).toString("hex")];
      if (!name) return;
      // the verdict, exactly as decode.rs attributes it: an atomic transaction fails every instruction in it
      let allowed = true;
      let reason = "";
      let errorCode = 0;
      if (failure) {
        allowed = false;
        const thisOne = failure.instructionIndex === ixIndex;
        const code = thisOne ? (failure.customCode ?? logError) : null;
        reason = thisOne ? blockReason(code) : "FAILED";
        errorCode = code ?? 0;
      }
      const errorName = errorCode ? (ERROR_NAMES[errorCode] ?? "") : "";
      const pda = account(ix, 0);
      const node = nodeOf(pda);
      const mandateId = node ? `${node}:${CHAIN}` : "";
      const id = `${tx.signature}:${ixIndex}`;
      const d = ix.data;
      switch (name) {
        case "create_mandate": {
          const expiry = i64(d, 40);
          if (d.length < 40 || expiry === null) return;
          const ensNode = hex0x(d.subarray(8, 40));
          rows.push({ entity: "Mandate", block: tx.slot, data: { id: `${ensNode}:${CHAIN}`, ensNode, chain: CHAIN, owner: account(ix, 1), agent: account(ix, 2), expiry: expiry.toString(), active: allowed, txHash: tx.signature, slot, timestamp, pda, kind: "create_mandate" } });
          return;
        }
        case "revoke_mandate": {
          if (!allowed) return;
          rows.push({ entity: "Mandate", block: tx.slot, data: { id: mandateId, ensNode: node, chain: CHAIN, owner: account(ix, 1), txHash: tx.signature, slot, timestamp, pda, kind: "revoke_mandate" } });
          return;
        }
        case "add_permission": {
          if (!allowed || d.length < 44) return;
          const target = base58(d.subarray(8, 40));
          const len = d[40] | (d[41] << 8) | (d[42] << 16) | (d[43] << 24);
          let at = 44;
          const instructions: string[] = [];
          for (let k = 0; k < len; k++) {
            if (d.length < at + 8) return;
            instructions.push(hex0x(d.subarray(at, at + 8)));
            at += 8;
          }
          const size = d[at];
          const spendLimit = u64(d, at + 1);
          const perTxLimit = u64(d, at + 9);
          if (size === undefined || spendLimit === null || perTxLimit === null) return;
          rows.push({ entity: "Permission", block: tx.slot, data: { id: `${mandateId}:${target}`, mandateId, ensNode: node, target, ...(instructions.length ? { instructions } : {}), discriminatorSize: size, perTxLimit: perTxLimit.toString(), totalLimit: spendLimit.toString(), txHash: tx.signature, slot, timestamp, kind: "add_permission" } });
          return;
        }
        case "remove_permission": {
          if (!allowed || d.length < 40) return;
          const target = base58(d.subarray(8, 40));
          rows.push({ entity: "Permission", block: tx.slot, data: { id: `${mandateId}:${target}`, mandateId, ensNode: node, target, txHash: tx.signature, slot, timestamp, kind: "remove_permission" } });
          return;
        }
        case "execute_payment": {
          const amount = u64(d, 8);
          if (amount === null) return;
          rows.push({ entity: "Action", block: tx.slot, data: { id, mandateId, ensNode: node, chain: CHAIN, timestamp, target: account(ix, 3), amount: amount.toString(), ...(allowed ? { allowed: true } : { blockReason: reason }), txHash: tx.signature, kind: "execute_payment", ...(errorCode ? { errorCode } : {}), agent: account(ix, 1), slot, pda, ...(errorName ? { errorName } : {}) } });
          return;
        }
        case "verify": {
          const targetIx = d[8];
          const amount = u64(d, 9);
          if (targetIx === undefined || amount === null) return;
          const sibling = tx.instructions[targetIx];
          const target = sibling ? (tx.accountKeys[sibling.programIdIndex] ?? "") : "";
          rows.push({ entity: "Action", block: tx.slot, data: { id, mandateId, ensNode: node, chain: CHAIN, timestamp, target, amount: amount.toString(), ...(allowed ? { allowed: true } : { blockReason: reason }), txHash: tx.signature, kind: "verify", ...(errorCode ? { errorCode } : {}), agent: account(ix, 1), slot, pda, ...(errorName ? { errorName } : {}) } });
          return;
        }
        default:
          return;
      }
    });
  }
  return rows;
}

/** PDA -> ens_node from the snapshot's own create rows. */
export function pdaIndex(rows: SolanaRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.entity !== "Mandate") continue;
    const pda = String(r.data.pda ?? "");
    const node = String(r.data.ensNode ?? "");
    if (pda && node) m.set(pda, node);
  }
  return m;
}

/** The mandate account's ens_node, straight from its bytes (discriminator 8, active 1, bump 1, pad 6, owner 32, agent 32, ens_node 32). */
export function ensNodeFromAccount(data: Uint8Array | null | undefined): string | null {
  if (!data || data.length < 112) return null;
  return hex0x(data.subarray(80, 112));
}

const rowKey = (r: SolanaRow) => `${r.entity}:${String(r.data.id ?? "")}:${String(r.data.txHash ?? "")}:${String(r.data.kind ?? "")}`;

/** Snapshot rows first, tail rows on top, one row per (entity, id, tx, kind), in block order so the fold replays history correctly. */
export function mergeRows(snapshot: SolanaRow[], tail: SolanaRow[]): SolanaRow[] {
  const seen = new Set<string>();
  const out: SolanaRow[] = [];
  for (const r of [...snapshot, ...tail]) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.block - b.r.block || a.i - b.i)
    .map((x) => x.r);
}

export interface TailResult {
  fromSlot: number;
  /** The slot the read reached: the chain's current slot when the read succeeded. */
  throughSlot: number;
  fetchedAt: string;
  signatures: number;
  rows: SolanaRow[];
  /** Set when the RPC could not be read: the page keeps the snapshot and says so. */
  error?: string;
  truncated?: boolean;
  /** The newest signature in `rows`, so the next read can ask only for what came after it. */
  newestSignature?: string;
  /** Rows are the last good read; the latest attempt failed (see `error`). */
  stale?: boolean;
  /** The first read is still running on the server; ask again in a moment. */
  loading?: boolean;
}

export interface TailOptions {
  program?: string;
  sinceSlot: number;
  /** ens_node for PDAs the window did not create (the snapshot's index); the chain is asked for the rest. */
  ensNodeOfPda: (pda: string) => string | null;
  /** How many signatures at most; the public RPC rate-limits freely. */
  maxSignatures?: number;
  concurrency?: number;
  /** Attempts per RPC call on a rate limit or a dropped connection, and the base of the quadratic backoff. */
  retries?: number;
  retryBaseMs?: number;
  /** Read only signatures newer than this one (an incremental refresh on top of a previous read). */
  untilSignature?: string;
  /** The pause between transaction reads: the public RPC limits per method. */
  pauseMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, tries = 4, baseMs = 400): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/429|Too Many|rate|timeout|ECONNRESET|fetch failed/i.test(msg) || i === tries - 1) throw e;
      await sleep(baseMs * (i + 1) * (i + 1));
    }
  }
  throw last;
}

/** Everything the program did since `sinceSlot`, failed transactions included. Never throws: an RPC failure comes back as `error`. */
export async function fetchTail(connection: Connection, opts: TailOptions): Promise<TailResult> {
  const program = new PublicKey(opts.program ?? AGENTRAIL_PROGRAM);
  const fetchedAt = new Date().toISOString();
  const max = opts.maxSignatures ?? 80;
  const retry = <T,>(fn: () => Promise<T>) => withRetry(fn, opts.retries ?? 4, opts.retryBaseMs ?? 400);
  try {
    const throughSlot = await retry(() => connection.getSlot("confirmed"));
    const sigs: { signature: string; slot: number }[] = [];
    let before: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await retry(() => connection.getSignaturesForAddress(program, { limit: 100, before, until: opts.untilSignature }, "confirmed"));
      if (page.length === 0) break;
      for (const s of page) {
        if (s.slot < opts.sinceSlot) break;
        sigs.push({ signature: s.signature, slot: s.slot });
      }
      const oldest = page[page.length - 1];
      if (oldest.slot < opts.sinceSlot || page.length < 100) break;
      if (sigs.length >= max) {
        truncated = true;
        break;
      }
      before = oldest.signature;
    }
    const wanted = sigs.slice(0, max);
    if (sigs.length > max) truncated = true;
    // one transaction per request, spaced out: the public RPC refuses batched getTransactions outright
    // ("Too many requests for a specific RPC call") but lets spaced singles through
    const txs: TailTx[] = [];
    for (const [i, s] of wanted.entries()) {
      if (i > 0) await sleep(opts.pauseMs ?? 600);
      const tx = await retry(() => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
      if (tx) txs.push(fromRpc(s.signature, tx));
    }
    // ens_node for PDAs neither the window nor the snapshot knows: read the account once each
    const asked = new Map<string, string | null>();
    const pdas = new Set<string>();
    for (const t of txs) for (const ix of t.instructions) if (t.accountKeys[ix.programIdIndex] === program.toBase58() && ix.accounts.length) pdas.add(t.accountKeys[ix.accounts[0]] ?? "");
    for (const pda of pdas) {
      if (!pda || opts.ensNodeOfPda(pda)) continue;
      try {
        const info = await retry(() => connection.getAccountInfo(new PublicKey(pda), "confirmed"));
        asked.set(pda, ensNodeFromAccount(info?.data));
      } catch {
        asked.set(pda, null);
      }
    }
    const rows = decodeTail(txs, (pda) => opts.ensNodeOfPda(pda) ?? asked.get(pda) ?? null, program.toBase58());
    return { fromSlot: opts.sinceSlot, throughSlot, fetchedAt, signatures: wanted.length, rows, ...(truncated ? { truncated: true } : {}), ...(wanted[0] ? { newestSignature: wanted[0].signature } : {}) };
  } catch (e) {
    return { fromSlot: opts.sinceSlot, throughSlot: opts.sinceSlot, fetchedAt, signatures: 0, rows: [], error: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e) };
  }
}

/**
 * The server's cache in front of the public RPC: a good read is served for `ttlMs`; a refresh after
 * that asks only for signatures newer than the last good read and merges them; a failed read is
 * served as the last good rows marked `stale` (or, with nothing good yet, as an error) and is not
 * retried for `errorTtlMs`. One read in flight at a time.
 */
export function cachedTail(ttlMs = 45_000, errorTtlMs = 15_000) {
  let good: { key: string; at: number; value: TailResult } | null = null;
  let lastError: { key: string; at: number; value: TailResult } | null = null;
  let inFlight: Promise<TailResult> | null = null;
  return async (connection: Connection, opts: TailOptions, force = false): Promise<TailResult> => {
    const key = `${opts.program ?? AGENTRAIL_PROGRAM}:${opts.sinceSlot}`;
    const now = Date.now();
    if (!force && good && good.key === key && now - good.at < ttlMs) return good.value;
    if (lastError && lastError.key === key && now - lastError.at < errorTtlMs) return lastError.value;
    if (inFlight) return inFlight;
    const base = good && good.key === key ? good.value : null;
    inFlight = fetchTail(connection, { ...opts, ...(base?.newestSignature ? { untilSignature: base.newestSignature } : {}) })
      .then((v) => {
        if (v.error) {
          const value: TailResult = base ? { ...base, error: v.error, stale: true, fetchedAt: v.fetchedAt } : v;
          lastError = { key, at: Date.now(), value };
          return value;
        }
        const merged: TailResult = base ? { ...v, rows: mergeRows(base.rows, v.rows), signatures: base.signatures + v.signatures, newestSignature: v.newestSignature ?? base.newestSignature, truncated: v.truncated || base.truncated } : v;
        good = { key, at: Date.now(), value: merged };
        lastError = null;
        return merged;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
