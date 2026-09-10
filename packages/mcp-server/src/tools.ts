/**
 * The four tools, as plain functions over injectable readers. Everything here is read-only: it
 * resolves names, reads mandates, runs the same checks the gate runs, and reads the index. It never
 * builds, signs or sends a transaction. An agent uses it to answer "what am I allowed to do?"
 * before it asks the chain to do it.
 */
import type { HistoryResult } from "@agentrail/query/src/history.ts";
import { assertAllowed, parseAllowed, type AllowedEntry } from "@agentrail/sdk/src/allowlist.ts";
import { discoverService, type EnsTextReader } from "@agentrail/sdk/src/discovery.ts";
import { MandateRefused } from "@agentrail/sdk/src/errors.ts";
import { hederaLongZeroAddress } from "@agentrail/sdk/src/tails/hedera.ts";
import { solanaLocalGate, type SolanaMandateState } from "@agentrail/sdk/src/tails/solana.ts";
import { namehash } from "viem/ens";

export const AGENT_KEYS = ["rail.version", "rail.agent.solana", "rail.agent.hedera", "rail.agent.base", "rail.erc8004", "rail.mandate.pda", "rail.allowed", "rail.status"] as const;
export const SERVICE_KEYS = ["rail.endpoint", "rail.chain", "rail.price", "rail.token", "rail.scheme", "description"] as const;

export type Chain = "solana:devnet" | "hedera:testnet" | "eip155:84532";

export interface EvmMandateView {
  id: string;
  exists: boolean;
  active: boolean;
  expiry: number;
  agent: string;
  permissions: { target: string; perTx: string; total: string; spent: string }[];
}

/** What the tools need from the outside world. `defaultDeps` (chains.ts) wires the real readers. */
export interface Deps {
  readText: EnsTextReader;
  history: (ensNode: string) => Promise<HistoryResult>;
  readSolana: (pda: string) => Promise<SolanaMandateState | null>;
  /** The associated token account of `payTo` for the mandate's mint: the destination `execute_payment` checks. */
  solanaDestination: (payTo: string) => string;
  readEvm: (chain: "hedera" | "base", agent: string) => Promise<EvmMandateView>;
  /** `EvmMandate.check` as a view: "ok" or the custom error name. */
  evmCheck: (chain: "hedera" | "base", mandateId: string, agent: string, destination: string, amount: bigint) => Promise<string>;
  now: () => bigint;
  owner: { solana: string };
  serviceNames: string[];
  agentName: string;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export interface MandateInfo {
  name: string;
  ensNode: string;
  kind: "agent" | "service" | "unknown";
  records: Record<string, string>;
  allowed: AllowedEntry[];
  live: { solana?: SolanaMandateState & { pda: string }; hedera?: EvmMandateView; base?: EvmMandateView };
  readOnly: true;
}

async function readRecords(deps: Deps, name: string, keys: readonly string[]): Promise<Record<string, string>> {
  const values = await Promise.all(keys.map((k) => deps.readText(name, k)));
  const out: Record<string, string> = {};
  keys.forEach((k, i) => {
    const v = values[i]?.trim();
    if (v) out[k] = v;
  });
  return out;
}

const norm = (n: string) => n.trim().toLowerCase();

/** get_mandate: the name resolved, its allow-list, and the live mandate on every chain it names. */
export async function getMandate(deps: Deps, rawName: string): Promise<MandateInfo> {
  const name = norm(rawName);
  const records = await readRecords(deps, name, [...AGENT_KEYS, ...SERVICE_KEYS]);
  const kind: MandateInfo["kind"] = records["rail.endpoint"] && records["rail.chain"] ? "service" : records["rail.allowed"] || records["rail.mandate.pda"] ? "agent" : "unknown";
  const info: MandateInfo = { name, ensNode: namehash(name), kind, records, allowed: [], live: {}, readOnly: true };
  if (kind !== "agent") return info;
  if (records["rail.allowed"]) info.allowed = parseAllowed(records["rail.allowed"], name);
  const pda = records["rail.mandate.pda"];
  const [sol, hed, bas] = await Promise.all([
    pda ? deps.readSolana(pda) : Promise.resolve(null),
    records["rail.agent.hedera"] ? deps.readEvm("hedera", records["rail.agent.hedera"]) : Promise.resolve(undefined),
    records["rail.agent.base"] ? deps.readEvm("base", records["rail.agent.base"]) : Promise.resolve(undefined),
  ]);
  if (pda && sol) info.live.solana = { ...sol, pda };
  if (hed) info.live.hedera = hed;
  if (bas) info.live.base = bas;
  return json(info);
}

export interface CheckResult {
  name: string;
  chain: Chain;
  payee: string;
  amount: string;
  allowed: boolean;
  /** The checks in the order the SDK runs them; the first failure decides. */
  checks: { gate: string; ok: boolean; detail: string }[];
  note: string;
}

/**
 * check_permission: would this payment be permitted? The same two gates the SDK applies before any
 * facilitator is contacted: the published allow-list, then the mandate itself (a local mirror of
 * `checks.rs` on Solana, the `check` view on the EVM). Nothing is signed.
 */
export async function checkPermission(deps: Deps, input: { name: string; chain: Chain; payee: string; amount: string }): Promise<CheckResult> {
  const name = norm(input.name);
  const amount = BigInt(input.amount);
  const result: CheckResult = { name, chain: input.chain, payee: input.payee, amount: amount.toString(), allowed: false, checks: [], note: "read-only: the answer the gate would give; nothing was signed or sent" };
  const records = await readRecords(deps, name, AGENT_KEYS);
  if (!records["rail.allowed"]) {
    result.checks.push({ gate: "ens", ok: false, detail: `${name} carries no rail.allowed record; it is not an AgentRail agent` });
    return result;
  }
  const allowed = parseAllowed(records["rail.allowed"], name);

  // 1. discovery is not authorization: the payee must be on the agent's own allow-list
  const solDestination = input.chain === "solana:devnet" ? deps.solanaDestination(input.payee) : null;
  const candidates = [input.payee, ...(solDestination ? [solDestination] : [])];
  const hit = allowed.find((e) => e.chain === input.chain && candidates.some((c) => c.toLowerCase() === e.target.toLowerCase()));
  if (!hit) {
    try {
      assertAllowed(allowed, { name, chain: input.chain, url: "", price: 0n, token: "", scheme: "x402", records: {} }, input.payee);
    } catch (e) {
      result.checks.push({ gate: "allow-list", ok: false, detail: e instanceof Error ? e.message : String(e) });
      return result; // refused before any chain is read, exactly like the SDK
    }
  }
  result.checks.push({ gate: "allow-list", ok: true, detail: `${hit?.target ?? input.payee} is listed on ${input.chain}${hit?.perTx ? ` (perTx ${hit.perTx}, total ${hit.total})` : ""}` });

  // 2. the mandate
  if (input.chain === "solana:devnet") {
    const pda = records["rail.mandate.pda"];
    const agent = records["rail.agent.solana"];
    if (!pda || !agent) {
      result.checks.push({ gate: "solana-mandate", ok: false, detail: "the name carries no rail.mandate.pda / rail.agent.solana" });
      return result;
    }
    const state = await deps.readSolana(pda);
    try {
      const p = solanaLocalGate(state, deps.now(), agent, solDestination!, amount);
      result.checks.push({ gate: "solana-local-gate (mirror of checks.rs)", ok: true, detail: `destination ${solDestination} permitted; spent ${p.spendTotal} of ${p.spendLimit}, per-tx cap ${p.perTxLimit}` });
      result.allowed = true;
    } catch (e) {
      result.checks.push({ gate: "solana-local-gate (mirror of checks.rs)", ok: false, detail: e instanceof MandateRefused ? e.reason : String(e) });
    }
    return result;
  }

  const evmChain = input.chain === "hedera:testnet" ? "hedera" : "base";
  const agent = records[evmChain === "hedera" ? "rail.agent.hedera" : "rail.agent.base"];
  if (!agent) {
    result.checks.push({ gate: "evm-mandate", ok: false, detail: `the name carries no rail.agent.${evmChain}` });
    return result;
  }
  const view = await deps.readEvm(evmChain, agent);
  const destination = evmChain === "hedera" && /^\d+\.\d+\.\d+$/.test(input.payee) ? hederaLongZeroAddress(input.payee) : input.payee;
  const verdict = await deps.evmCheck(evmChain, view.id, agent, destination, amount);
  const ok = verdict === "ok";
  result.checks.push({ gate: "EvmMandate.check (view)", ok, detail: ok ? `mandate ${view.id} permits ${destination} for ${amount}` : verdict });
  result.allowed = ok;
  return result;
}

export interface ServiceInfo {
  name: string;
  chain: string;
  url: string;
  price: string;
  token: string;
  scheme: string;
  description?: string;
  /** Payees the agent's rail.allowed permits on this chain. */
  allowedPayees: string[];
  error?: string;
}

/** list_services: what an agent can discover, resolved from ENS, with what its own allow-list says about each chain. */
export async function listServices(deps: Deps, names?: string[]): Promise<{ agent: string; services: ServiceInfo[] }> {
  const list = (names?.length ? names : deps.serviceNames).map(norm);
  const agentRecords = await readRecords(deps, deps.agentName, ["rail.allowed"]);
  const allowed = agentRecords["rail.allowed"] ? parseAllowed(agentRecords["rail.allowed"], deps.agentName) : [];
  const services = await Promise.all(
    list.map(async (name): Promise<ServiceInfo> => {
      try {
        const s = await discoverService(name, deps.readText);
        return { name, chain: s.chain, url: s.url, price: s.price.toString(), token: s.token, scheme: s.scheme, description: s.description, allowedPayees: allowed.filter((a) => a.chain === s.chain).map((a) => a.target) };
      } catch (e) {
        return { name, chain: "", url: "", price: "", token: "", scheme: "", allowedPayees: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return { agent: deps.agentName, services };
}

export interface HistoryInfo {
  ensNode: string;
  sources: HistoryResult["sources"];
  summary: { actions: number; allowed: number; blocked: number; blockedByCode: Record<string, number> };
  rows: { chain: string; kind: string; timestamp: string; target: string; amount: string; allowed: boolean; errorCode: number | null; blockReason: string | null; txHash: string }[];
  truncated: boolean;
}

/** get_history: the fixed query over three chains, never the MCP, never model-generated. */
export async function getHistory(deps: Deps, input: { name?: string; ensNode?: string; blockedOnly?: boolean; limit?: number }): Promise<HistoryInfo> {
  const ensNode = input.ensNode ?? namehash(norm(input.name ?? deps.agentName));
  const h = await deps.history(ensNode);
  let rows = h.mandates.flatMap((m) => m.actions.map((a) => ({ chain: m.chain, kind: a.kind, timestamp: a.timestamp, target: a.target, amount: a.amount, allowed: a.allowed, errorCode: a.errorCode, blockReason: a.blockReason, txHash: a.txHash }))).sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  const blocked = rows.filter((r) => !r.allowed);
  const blockedByCode: Record<string, number> = {};
  for (const b of blocked) {
    const k = b.errorCode ? String(b.errorCode) : (b.blockReason ?? "FAILED");
    blockedByCode[k] = (blockedByCode[k] ?? 0) + 1;
  }
  const summary = { actions: rows.length, allowed: rows.length - blocked.length, blocked: blocked.length, blockedByCode };
  if (input.blockedOnly) rows = blocked;
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  return { ensNode, sources: h.sources, summary, rows: rows.slice(0, limit), truncated: rows.length > limit };
}
