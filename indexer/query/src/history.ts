/**
 * One query, three chains. The shared schema (indexer/schema.graphql) is served by three sources:
 *
 *   sepolia   Subgraph Studio      mandate lifecycle, rail.* records, allow-list, ERC-8004 agent
 *   base      Subgraph Studio      EvmMandate permissions and every authorized spend
 *   solana    Substreams stream    execute_payment / verify, successes and refusals (solana-sink.ts)
 *
 * Because every source emits the same entity shapes keyed by `ensNode`, the SAME query text runs
 * against each and the rows concatenate. No per-source translation, no client-side merge logic
 * beyond `[...a, ...b, ...c]`. That is what the shared schema buys (SPEC §7.3, §8.4).
 *
 * The query is fixed on purpose: reading our own index is a known question (SPEC §8.7).
 */
import { readRows, type SolanaRow } from "./solana-sink.ts";

/** The one query. Runs verbatim on every source. */
export const HISTORY_QUERY = `query History($ensNode: Bytes!) {
  mandates(where: { ensNode: $ensNode }) {
    id
    chain
    ensNode
    ensName
    owner
    agent
    expiry
    active
    permissions(orderBy: updatedAt) { id target instructions perTxLimit totalLimit spentTotal source targetChain }
    actions(orderBy: timestamp) { id kind timestamp target amount allowed blockReason errorCode txHash }
  }
}`;

export interface Permission {
  id: string;
  target: string;
  /** Instruction-keyed entries (Solana `verify`): allowed discriminators as hex, left-aligned in 8 bytes. */
  instructions: string[];
  perTxLimit: string;
  totalLimit: string;
  spentTotal: string;
  source: string;
  targetChain: string | null;
}

export interface Action {
  id: string;
  kind: string;
  timestamp: string;
  target: string;
  amount: string;
  allowed: boolean;
  blockReason: string | null;
  errorCode: number | null;
  txHash: string;
}

export interface Mandate {
  id: string;
  chain: string;
  ensNode: string;
  ensName: string | null;
  owner: string;
  agent: string;
  expiry: string;
  active: boolean;
  permissions: Permission[];
  actions: Action[];
}

export interface Source {
  chain: string;
  /** Studio query URL, or "substreams" for the sink. */
  url: string;
}

export interface HistoryResult {
  ensNode: string;
  mandates: Mandate[];
  sources: { chain: string; url: string; mandates: number; actions: number; error?: string }[];
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

/** Run the fixed query on one Studio endpoint. */
export async function queryStudio(url: string, apiKey: string, ensNode: string, fetchImpl: FetchLike = fetch): Promise<Mandate[]> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: HISTORY_QUERY, variables: { ensNode } }),
  });
  const body = (await res.json()) as { data?: { mandates?: Mandate[] }; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`${url}: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data?.mandates ?? [];
}

/**
 * The Solana leg: the rows the sink streamed from the provider, folded into the same shape.
 * A mandate re-issued in the range is one row; every action stays.
 */
export function foldSolana(rows: SolanaRow[], ensNode: string): Mandate[] {
  const node = ensNode.toLowerCase();
  const byMandate = new Map<string, Mandate>();
  const permissionIds = new Set<string>();
  const actionIds = new Set<string>();
  for (const row of rows) {
    const d = row.data as Record<string, any>;
    const rowNode = String(d.ensNode ?? "").toLowerCase();
    if (rowNode !== node) continue;
    const id = String(d.mandateId ?? d.id ?? "");
    if (!id) continue;
    let m = byMandate.get(id);
    if (!m) {
      m = { id, chain: "solana", ensNode: rowNode, ensName: null, owner: "", agent: "", expiry: "0", active: false, permissions: [], actions: [] };
      byMandate.set(id, m);
    }
    if (row.entity === "Mandate") {
      if (d.kind === "create_mandate") {
        m.owner = d.owner ?? m.owner;
        m.agent = d.agent ?? m.agent;
        m.expiry = String(d.expiry ?? "0");
        m.active = Boolean(d.active);
        m.permissions = []; // a fresh mandate starts without permissions
      } else if (d.kind === "revoke_mandate") {
        m.active = false;
      }
    } else if (row.entity === "Permission") {
      if (d.kind === "remove_permission") {
        m.permissions = m.permissions.filter((p) => p.id !== d.id);
        continue;
      }
      if (permissionIds.has(`${row.block}:${d.id}`)) continue;
      permissionIds.add(`${row.block}:${d.id}`);
      m.permissions = m.permissions.filter((p) => p.id !== d.id);
      m.permissions.push({ id: d.id, target: d.target, instructions: Array.isArray(d.instructions) ? d.instructions.map(String) : [], perTxLimit: String(d.perTxLimit ?? "0"), totalLimit: String(d.totalLimit ?? "0"), spentTotal: "0", source: "onchain", targetChain: "solana:devnet" });
    } else if (row.entity === "Action") {
      if (actionIds.has(d.id)) continue;
      actionIds.add(d.id);
      const allowed = d.allowed === true;
      m.actions.push({ id: d.id, kind: d.kind, timestamp: String(d.timestamp ?? "0"), target: d.target, amount: String(d.amount ?? "0"), allowed, blockReason: allowed ? null : d.blockReason || "FAILED", errorCode: allowed ? null : Number(d.errorCode ?? 0) || null, txHash: d.txHash });
      if (allowed && d.kind === "execute_payment") {
        const p = m.permissions.find((x) => x.target === d.target);
        if (p) p.spentTotal = (BigInt(p.spentTotal) + BigInt(d.amount ?? 0)).toString();
      }
    }
  }
  return [...byMandate.values()];
}

export interface HistoryConfig {
  sepoliaUrl: string;
  baseUrl: string;
  apiKey: string;
  solanaRows?: () => SolanaRow[];
  fetch?: FetchLike;
}

/** The whole history of one mandate name across three chains, from one query text. */
export async function fetchHistory(ensNode: string, cfg: HistoryConfig): Promise<HistoryResult> {
  const sources: HistoryResult["sources"] = [];
  const mandates: Mandate[] = [];
  const legs: [string, string, () => Promise<Mandate[]>][] = [
    ["sepolia", cfg.sepoliaUrl, () => queryStudio(cfg.sepoliaUrl, cfg.apiKey, ensNode, cfg.fetch)],
    ["base", cfg.baseUrl, () => queryStudio(cfg.baseUrl, cfg.apiKey, ensNode, cfg.fetch)],
    ["solana", "substreams:devnet.sol.streamingfast.io:443", async () => foldSolana((cfg.solanaRows ?? readRows)(), ensNode)],
  ];
  for (const [chain, url, run] of legs) {
    try {
      const rows = await run();
      mandates.push(...rows);
      sources.push({ chain, url, mandates: rows.length, actions: rows.reduce((n, m) => n + m.actions.length, 0) });
    } catch (e) {
      sources.push({ chain, url, mandates: 0, actions: 0, error: String(e) });
    }
  }
  return { ensNode, mandates, sources };
}

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
}

/** CLI: yarn history [ensNode] — prints the merged history as one table. */
if (process.argv[1] && process.argv[1].endsWith("history.ts")) {
  const ensNode = process.argv[2] ?? env("RAIL_NODE");
  const result = await fetchHistory(ensNode, { sepoliaUrl: env("SUBGRAPH_SEPOLIA_URL"), baseUrl: env("SUBGRAPH_BASE_URL"), apiKey: env("GRAPH_API_KEY") });
  console.log(`\n${ensNode}\n`);
  for (const s of result.sources) console.log(`  ${s.chain.padEnd(8)} ${s.mandates} mandate(s), ${s.actions} action(s)  ${s.error ? "ERROR " + s.error : s.url}`);
  console.log("\n  chain    kind             allowed  reason         amount      target                                        tx");
  for (const m of result.mandates) {
    for (const a of m.actions) {
      console.log(`  ${m.chain.padEnd(8)} ${a.kind.padEnd(16)} ${String(a.allowed).padEnd(8)} ${(a.blockReason ?? "").padEnd(14)} ${a.amount.padStart(10)}  ${a.target.slice(0, 44).padEnd(44)}  ${a.txHash.slice(0, 16)}…`);
    }
  }
  const blocked = result.mandates.flatMap((m) => m.actions).filter((a) => !a.allowed);
  console.log(`\n  ${result.mandates.length} mandate rows on ${new Set(result.mandates.map((m) => m.chain)).size} chains, ${result.mandates.reduce((n, m) => n + m.actions.length, 0)} actions, ${blocked.length} blocked (${blocked.map((b) => b.errorCode ?? b.blockReason).join(", ")})`);
}
