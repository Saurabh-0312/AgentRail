/**
 * The tool surface: plain, typed functions. No model sits inside any of them (SPEC §8.7); the model
 * may call them, and the mandate decides.
 *
 *   discoverService(name)     ENS -> { chain, url, price, token }           @agentrail/sdk (Phase 3)
 *   querySubgraph(question)   natural language over third-party subgraphs  Subgraph MCP (Phase 4)
 *   getMyMandate()            caps, spent, remaining, expiry, active        the FIXED query (@agentrail/query)
 *   requestPayment(request)   the only path to money                       adapter -> allow-list -> gate -> settle
 *   requestAction(action)     the only path to an instruction on Alice's   local verify mirror -> verify + sibling
 *                             delegated account (never moves value)
 *
 * Reading our own index is a known question with a known shape, so it is a fixed query: never the
 * MCP, never model-generated. Every refusal is logged with what was sent (nothing) and, when the
 * caller asks for proof, with the chain's own verdict and signature.
 */
import type { HistoryResult } from "@agentrail/query/src/history.ts";
import {
  CHAINS,
  MandateRefused,
  NotOnAllowList,
  SettlementFailed,
  assertAllowed,
  directQuote,
  discoverService as resolveService,
  solanaLocalVerifyGate,
  type AdapterRegistry,
  type AllowedEntry,
  type DiscoveredService,
  type EnsTextReader,
  type LandedTransaction,
  type MandateRef,
  type ServiceRef,
  type SiblingInstruction,
  type SolanaGateClient,
} from "@agentrail/sdk";
import { AuthorityType, createApproveInstruction, createCloseAccountInstruction, createRevokeInstruction, createSetAuthorityInstruction } from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

import type { ExploreResult } from "./explore.ts";
import type { RunLog } from "./transcript.ts";

export const solanaExplorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

// ---- what the tools return --------------------------------------------------------------------

export interface PermissionView {
  target: string;
  perTx: string;
  total: string;
  spent: string;
  /** null when the cap is 0 (unlimited). */
  remaining: string | null;
  /** Instruction-keyed entries: the allowed discriminators (hex). Empty for payment entries. */
  instructions: string[];
  source: string;
}

export interface MandateView {
  ensNode: string;
  asOf: string;
  readVia: "fixed-query";
  chains: {
    chain: string;
    url: string;
    active: boolean;
    expiry: string;
    permissions: PermissionView[];
    actions: { total: number; allowed: number; blocked: number; blockedReasons: Record<string, number> };
    error?: string;
  }[];
  /** The live account, when a Solana rail is configured: the caps as they are right now. */
  solana?: {
    mandate: string;
    active: boolean;
    expiry: string;
    permissions: PermissionView[];
    delegation?: { account: string; delegate: string | null; delegatedAmount: string; balance: string; delegateIsMandate: boolean };
  };
}

export interface ServicePaymentRequest {
  /** ENS name of the service, e.g. feed.agentrail.eth. */
  service: string;
  /** For a price feed: which symbols. */
  symbols?: string[];
  /** For a GraphQL gateway: the query to buy. */
  query?: string;
  reason?: string;
}

export interface DirectPaymentRequest {
  chain: "solana:devnet";
  /** The payee wallet; its token account for the asset is the destination the mandate checks. */
  payTo: string;
  amount: string;
  asset?: string;
  reason?: string;
}

export type PaymentRequest = ServicePaymentRequest | DirectPaymentRequest;

export interface ChainVerdict extends LandedTransaction {
  explorer: string;
}

export interface PaymentOutcome {
  status: "paid" | "refused" | "failed";
  chain: string;
  service?: string;
  payTo?: string;
  destination?: string;
  amount?: string;
  asset?: string;
  reason?: string;
  refusedBy?: "no-mandate" | "allow-list" | "local-gate" | "evm-check" | "chain";
  gate?: string;
  transactionId?: string;
  explorer?: string;
  data?: unknown;
  /** Paid requests that left the process during this call. 0 on every refusal. */
  paidRequestsSent: number;
  /** Set when the caller asked for proof: the same request sent anyway, and what the chain said. */
  chainVerdict?: ChainVerdict;
  error?: string;
}

export type TokenAction =
  | { instruction: "revoke"; reason?: string }
  | { instruction: "approve"; delegate: string; amount: string; reason?: string }
  | { instruction: "setAuthority"; newAuthority: string; authorityType?: "AccountOwner" | "CloseAccount"; reason?: string }
  | { instruction: "closeAccount"; destination: string; reason?: string };

export interface ActionOutcome {
  status: "executed" | "refused" | "failed";
  instruction: string;
  tag: number;
  program: string;
  account: string;
  reason?: string;
  refusedBy?: "no-mandate" | "local-gate" | "chain";
  signature?: string;
  explorer?: string;
  /** Whether a transaction left the process. false on every local refusal. */
  sent: boolean;
  chainVerdict?: ChainVerdict;
  error?: string;
}

export interface SubgraphAnswer {
  question: string;
  answer: string;
  model: string;
  steps: { tool: string; input: Record<string, unknown>; output: string }[];
}

// ---- configuration ------------------------------------------------------------------------------

/** The Solana rail: Alice's delegated USDC account and the mandate that governs it. */
export interface SolanaRail {
  client: SolanaGateClient;
  /** base58 agent key: signs `execute_payment` and `verify`, holds nothing. */
  agent: string;
  /** The mandate PDA. */
  mandate: string;
  /** Alice's wallet: the token authority (and the demo's fee payer). */
  owner: string;
  /** Alice's delegated token account. */
  ownerTokenAccount: string;
  /** The asset the account holds (devnet USDC mint). */
  asset: string;
  /** Live delegation on the account, for getMyMandate. */
  readDelegation?: () => Promise<{ delegate: string | null; delegatedAmount: bigint; balance: bigint }>;
}

export interface ToolsConfig {
  agentName: string;
  ensNode: string;
  readText: EnsTextReader;
  /** The model-driven MCP loop (explore.ts). Third-party subgraphs only. */
  explore: (question: string) => Promise<ExploreResult>;
  /** The fixed query (fetchHistory bound to its endpoints). */
  history: (ensNode: string) => Promise<HistoryResult>;
  registry: AdapterRegistry;
  mandates: Partial<Record<string, MandateRef>>;
  /** rail.allowed on the agent's own name, parsed. */
  allowed: AllowedEntry[];
  solana?: SolanaRail;
  /** Paid requests sent so far, from the counting fetch the adapters were built with. */
  paidRequests?: () => number;
  /**
   * When the local gate refuses a Solana request, send it anyway so the chain's own refusal is on
   * record with a signature. Off for normal operation; on for the attack harness and the demo.
   */
  proveOnChain?: boolean;
  log: RunLog;
}

export interface AgentTools {
  discoverService(ensName: string): Promise<DiscoveredService>;
  querySubgraph(question: string): Promise<SubgraphAnswer>;
  getMyMandate(): Promise<MandateView>;
  requestPayment(request: PaymentRequest): Promise<PaymentOutcome>;
  requestAction(action: TokenAction): Promise<ActionOutcome>;
}

// ---- helpers ------------------------------------------------------------------------------------

const viewPermission = (p: { target: string; perTxLimit: string; totalLimit: string; spentTotal: string; instructions?: string[]; source?: string }): PermissionView => ({
  target: p.target,
  perTx: p.perTxLimit,
  total: p.totalLimit,
  spent: p.spentTotal,
  remaining: p.totalLimit === "0" ? null : (BigInt(p.totalLimit) - BigInt(p.spentTotal)).toString(),
  instructions: p.instructions ?? [],
  source: p.source ?? "onchain",
});

/** What to ask a discovered service for. The feed is a GET per symbol list; a Graph gateway takes a GraphQL POST. */
export function requestFor(service: DiscoveredService, req: ServicePaymentRequest): ServiceRef {
  const base = service.url.replace(/\/$/, "");
  if (/\/(subgraphs|deployments)\/id\//.test(service.url)) {
    const query = req.query ?? "{ _meta { block { number } } }";
    return { chain: service.chain, url: service.url, request: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) } };
  }
  if (service.name.startsWith("feed.")) {
    const symbols = (req.symbols?.length ? req.symbols : ["SOL", "HBAR"]).map((s) => s.toUpperCase());
    return { chain: service.chain, url: `${base}/price/${symbols.join(",")}` };
  }
  return { chain: service.chain, url: service.url };
}

const toSibling = (ix: TransactionInstruction): SiblingInstruction => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: new Uint8Array(ix.data),
});

/**
 * The SPL Token instruction an action names, on Alice's delegated account, with Alice as authority.
 * Transfers are deliberately absent: value moves only through requestPayment, the destination-keyed gate.
 */
export function buildTokenSibling(action: TokenAction, rail: Pick<SolanaRail, "owner" | "ownerTokenAccount">): SiblingInstruction {
  const account = new PublicKey(rail.ownerTokenAccount);
  const owner = new PublicKey(rail.owner);
  switch (action.instruction) {
    case "revoke":
      return toSibling(createRevokeInstruction(account, owner));
    case "approve":
      return toSibling(createApproveInstruction(account, new PublicKey(action.delegate), owner, BigInt(action.amount)));
    case "setAuthority":
      return toSibling(createSetAuthorityInstruction(account, owner, action.authorityType === "CloseAccount" ? AuthorityType.CloseAccount : AuthorityType.AccountOwner, new PublicKey(action.newAuthority)));
    case "closeAccount":
      return toSibling(createCloseAccountInstruction(account, new PublicKey(action.destination), owner));
    default:
      throw new Error(`unknown instruction ${(action as { instruction: string }).instruction}`);
  }
}

// ---- the tools ----------------------------------------------------------------------------------

export function createTools(cfg: ToolsConfig): AgentTools {
  const log = cfg.log;
  const paid = () => cfg.paidRequests?.() ?? 0;

  async function discoverService(ensName: string): Promise<DiscoveredService> {
    const service = await resolveService(ensName, cfg.readText);
    log.add("tool", `discoverService(${ensName})`, { chain: service.chain, url: service.url, price: service.price.toString(), token: service.token });
    return service;
  }

  async function querySubgraph(question: string): Promise<SubgraphAnswer> {
    log.add("tool", "querySubgraph", { question });
    const r = await cfg.explore(question);
    for (const s of r.steps) log.add("tool", `  mcp:${s.tool}`, { input: s.input, output: s.output.replace(/\s+/g, " ").slice(0, 400) });
    log.add("model", `querySubgraph answer (${r.model})`, { answer: r.answer.slice(0, 1200) });
    return { question, answer: r.answer, model: r.model, steps: r.steps.map((s) => ({ tool: s.tool, input: s.input, output: s.output.slice(0, 2000) })) };
  }

  async function getMyMandate(): Promise<MandateView> {
    const h = await cfg.history(cfg.ensNode);
    const view: MandateView = {
      ensNode: cfg.ensNode,
      asOf: new Date().toISOString(),
      readVia: "fixed-query",
      chains: h.sources.map((s) => {
        const m = h.mandates.find((x) => x.chain === s.chain);
        const blockedReasons: Record<string, number> = {};
        for (const a of m?.actions ?? []) {
          if (a.allowed) continue;
          const k = a.errorCode ? String(a.errorCode) : a.blockReason ?? "FAILED";
          blockedReasons[k] = (blockedReasons[k] ?? 0) + 1;
        }
        const total = m?.actions.length ?? 0;
        const blocked = m?.actions.filter((a) => !a.allowed).length ?? 0;
        return {
          chain: s.chain,
          url: s.url,
          active: m?.active ?? false,
          expiry: m?.expiry ?? "0",
          permissions: (m?.permissions ?? []).map(viewPermission),
          actions: { total, allowed: total - blocked, blocked, blockedReasons },
          ...(s.error ? { error: s.error } : {}),
        };
      }),
    };
    if (cfg.solana) {
      const rail = cfg.solana;
      const state = await rail.client.readMandate(rail.mandate);
      const delegation = rail.readDelegation ? await rail.readDelegation() : undefined;
      view.solana = {
        mandate: rail.mandate,
        active: state?.active ?? false,
        expiry: state ? state.expiry.toString() : "0",
        permissions: (state?.permissions ?? []).map((p) => viewPermission({ target: p.key, perTxLimit: p.perTxLimit.toString(), totalLimit: p.spendLimit.toString(), spentTotal: p.spendTotal.toString(), instructions: p.discriminators ?? [] })),
        ...(delegation
          ? {
              delegation: {
                account: rail.ownerTokenAccount,
                delegate: delegation.delegate,
                delegatedAmount: delegation.delegatedAmount.toString(),
                balance: delegation.balance.toString(),
                delegateIsMandate: delegation.delegate === rail.mandate,
              },
            }
          : {}),
      };
    }
    log.add("tool", "getMyMandate (fixed query)", {
      chains: view.chains.map((c) => `${c.chain}: ${c.active ? "active" : "inactive"}, ${c.permissions.length} permission(s), ${c.actions.total} action(s), ${c.actions.blocked} blocked${c.error ? " ERROR" : ""}`),
      ...(view.solana ? { solanaLive: `${view.solana.active ? "active" : "inactive"}, ${view.solana.permissions.length} permission(s)${view.solana.delegation ? `, delegate ${view.solana.delegation.delegate ?? "none"}${view.solana.delegation.delegateIsMandate ? " (the mandate)" : " (NOT the mandate)"}` : ""}` } : {}),
    });
    return view;
  }

  /** Send the same request the local gate refused, so the chain's own refusal is on record. */
  async function proveExecutePayment(rail: SolanaRail, destination: string, amount: bigint, label: string): Promise<ChainVerdict> {
    const raw = await rail.client.buildExecutePayment(rail.mandate, destination, amount);
    const landed = await rail.client.land(raw);
    const verdict = { ...landed, explorer: solanaExplorer(landed.signature) };
    log.add("chain", `${label}: execute_payment sent for the record -> ${landed.failed ? "REVERTED" : "LANDED"}`, { signature: landed.signature, error: landed.errorLine, explorer: verdict.explorer });
    if (!landed.failed) throw new Error(`chain accepted what the gate refused: ${landed.signature}`);
    return verdict;
  }

  async function requestPayment(request: PaymentRequest): Promise<PaymentOutcome> {
    const before = paid();
    const sent = () => paid() - before;

    if ("service" in request) {
      const service = await discoverService(request.service);
      const mandate = cfg.mandates[service.chain];
      log.add("payment", `requestPayment(${service.name})`, { chain: service.chain, reason: request.reason });
      if (!mandate) {
        log.add("refusal", `${service.name}: no mandate on ${service.chain}; nothing sent`, { refusedBy: "no-mandate" });
        return { status: "refused", chain: service.chain, service: service.name, reason: "NoMandateOnChain", refusedBy: "no-mandate", paidRequestsSent: sent() };
      }
      if (!cfg.allowed.some((e) => e.chain === service.chain)) {
        log.add("refusal", `${service.name}: rail.allowed lists no payee on ${service.chain}; nothing sent`, { refusedBy: "allow-list" });
        return { status: "refused", chain: service.chain, service: service.name, reason: "NotOnAllowList", refusedBy: "allow-list", paidRequestsSent: sent() };
      }
      let adapter;
      try {
        adapter = cfg.registry.select(service.chain);
      } catch (e) {
        return { status: "refused", chain: service.chain, service: service.name, reason: "NoAdapterForChain", refusedBy: "no-mandate", paidRequestsSent: sent(), error: String(e) };
      }
      const ref = requestFor(service, request);
      const quote = await adapter.quote(ref);
      log.add("payment", `  402 quote: ${quote.amount} units of ${quote.asset} to ${quote.payTo}`, { resource: quote.requirements.resource });
      try {
        assertAllowed(cfg.allowed, service, quote.payTo);
      } catch (e) {
        if (!(e instanceof NotOnAllowList)) throw e;
        log.add("refusal", `${service.name}: payee ${quote.payTo} is not on rail.allowed; paid requests sent: ${sent()}`, { refusedBy: "allow-list" });
        return { status: "refused", chain: service.chain, service: service.name, payTo: quote.payTo, amount: quote.amount.toString(), asset: quote.asset, reason: "NotOnAllowList", refusedBy: "allow-list", paidRequestsSent: sent() };
      }
      let auth;
      try {
        auth = await adapter.authorize(mandate, quote);
      } catch (e) {
        if (!(e instanceof MandateRefused)) throw e;
        const refusedBy = service.chain === CHAINS.SOLANA_DEVNET ? "local-gate" : "evm-check";
        log.add("refusal", `${service.name}: mandate refused ${e.reason}; paid requests sent: ${sent()}`, { refusedBy, detail: e.detail });
        return { status: "refused", chain: service.chain, service: service.name, payTo: quote.payTo, amount: quote.amount.toString(), asset: quote.asset, reason: e.reason, refusedBy, paidRequestsSent: sent() };
      }
      const gate = auth.gate.kind === "evm-authorize" ? auth.gate.txHash : "execute_payment";
      log.add("payment", `  gate passed: ${gate}`);
      try {
        const done = await adapter.settle(auth);
        const body = done.response as Record<string, unknown> | undefined;
        const data = body && "data" in body ? body.data : body;
        log.add("payment", `  paid ${quote.amount} units -> ${done.transactionId}`, { explorer: done.explorer });
        return { status: "paid", chain: service.chain, service: service.name, payTo: quote.payTo, amount: quote.amount.toString(), asset: quote.asset, gate, transactionId: done.transactionId, explorer: done.explorer, data, paidRequestsSent: sent() };
      } catch (e) {
        if (!(e instanceof SettlementFailed)) throw e;
        log.add("note", `  settlement failed after the gate recorded the spend: ${e.message}`, { body: e.body });
        return { status: "failed", chain: service.chain, service: service.name, payTo: quote.payTo, amount: quote.amount.toString(), asset: quote.asset, gate, error: e.message, paidRequestsSent: sent() };
      }
    }

    // A direct payment: the agent names a payee on Alice's delegated account; the gate names the answer.
    const rail = cfg.solana;
    const chain = request.chain;
    log.add("payment", `requestPayment(direct ${chain} -> ${request.payTo}, ${request.amount})`, { reason: request.reason });
    if (!rail || chain !== CHAINS.SOLANA_DEVNET) {
      log.add("refusal", `no mandate on ${chain}; nothing sent`, { refusedBy: "no-mandate" });
      return { status: "refused", chain, payTo: request.payTo, amount: request.amount, reason: "NoMandateOnChain", refusedBy: "no-mandate", paidRequestsSent: 0 };
    }
    const asset = request.asset ?? rail.asset;
    const amount = BigInt(request.amount);
    const destination = await rail.client.destinationTokenAccount(request.payTo, asset);
    const listed = cfg.allowed.find((e) => e.chain === chain && (e.target === destination || e.target === request.payTo));
    if (!listed) {
      log.add("refusal", `${request.payTo} (token account ${destination}) is not on rail.allowed; nothing sent`, { refusedBy: "allow-list" });
      const out: PaymentOutcome = { status: "refused", chain, payTo: request.payTo, destination, amount: request.amount, asset, reason: "NotOnAllowList", refusedBy: "allow-list", paidRequestsSent: 0 };
      if (cfg.proveOnChain) out.chainVerdict = await proveExecutePayment(rail, destination, amount, `pay ${request.amount} to ${request.payTo}`);
      return out;
    }
    const adapter = cfg.registry.select(chain);
    const quote = directQuote({ chain, resource: `agentrail://pay/${encodeURIComponent(request.reason ?? "direct")}`, amount, asset, payTo: request.payTo });
    let auth;
    try {
      auth = await adapter.authorize({ chain, id: rail.mandate }, quote);
    } catch (e) {
      if (!(e instanceof MandateRefused)) throw e;
      log.add("refusal", `mandate refused ${e.reason}; nothing sent`, { refusedBy: "local-gate", detail: e.detail });
      const out: PaymentOutcome = { status: "refused", chain, payTo: request.payTo, destination, amount: request.amount, asset, reason: e.reason, refusedBy: "local-gate", paidRequestsSent: 0 };
      if (cfg.proveOnChain) out.chainVerdict = await proveExecutePayment(rail, destination, amount, `pay ${request.amount} to ${request.payTo}`);
      return out;
    }
    try {
      const done = await adapter.settle(auth);
      log.add("payment", `  execute_payment landed -> ${done.transactionId}`, { explorer: done.explorer });
      return { status: "paid", chain, payTo: request.payTo, destination, amount: request.amount, asset, gate: "execute_payment", transactionId: done.transactionId, explorer: done.explorer, paidRequestsSent: 0 };
    } catch (e) {
      // the local mirror said yes and the chain said no: the chain wins, and the disagreement is logged
      const m = String(e).match(/\(([1-9A-HJ-NP-Za-km-z]{60,})\)/);
      log.add("refusal", `chain refused what the local gate allowed: ${String(e)}`, { refusedBy: "chain" });
      return { status: "refused", chain, payTo: request.payTo, destination, amount: request.amount, asset, reason: "chain", refusedBy: "chain", paidRequestsSent: 0, error: String(e), ...(m ? { transactionId: m[1], explorer: solanaExplorer(m[1]) } : {}) };
    }
  }

  async function requestAction(action: TokenAction): Promise<ActionOutcome> {
    const rail = cfg.solana;
    const label = `requestAction(${action.instruction})`;
    log.add("action", label, { ...action });
    if (!rail) {
      log.add("refusal", `${label}: no mandate on solana:devnet; nothing sent`, { refusedBy: "no-mandate" });
      return { status: "refused", instruction: action.instruction, tag: -1, program: "", account: "", reason: "NoMandateOnChain", refusedBy: "no-mandate", sent: false };
    }
    const sibling = buildTokenSibling(action, rail);
    const tag = sibling.data[0];
    const base = { instruction: action.instruction, tag, program: sibling.programId, account: rail.ownerTokenAccount };
    const [state, now] = await Promise.all([rail.client.readMandate(rail.mandate), rail.client.now()]);
    try {
      solanaLocalVerifyGate(state, now, rail.agent, sibling, 0n);
    } catch (e) {
      if (!(e instanceof MandateRefused)) throw e;
      log.add("refusal", `${label}: mandate refuses ${e.reason} (SPL Token tag ${tag}); nothing sent`, { refusedBy: "local-gate", detail: e.detail });
      const out: ActionOutcome = { ...base, status: "refused", reason: e.reason, refusedBy: "local-gate", sent: false };
      if (cfg.proveOnChain) {
        const signed = await rail.client.buildVerifiedInstruction(rail.mandate, sibling, 0n);
        const landed = await rail.client.land(signed);
        out.chainVerdict = { ...landed, explorer: solanaExplorer(landed.signature) };
        out.sent = true;
        log.add("chain", `${label}: verify + ${action.instruction} sent for the record -> ${landed.failed ? "REVERTED" : "LANDED"}`, { signature: landed.signature, error: landed.errorLine, explorer: out.chainVerdict.explorer });
        if (!landed.failed) throw new Error(`chain accepted what the gate refused: ${landed.signature}`);
      }
      return out;
    }
    const signed = await rail.client.buildVerifiedInstruction(rail.mandate, sibling, 0n);
    const landed = await rail.client.land(signed);
    const verdict = { ...landed, explorer: solanaExplorer(landed.signature) };
    if (landed.failed) {
      log.add("refusal", `${label}: chain refused ${landed.errorName ?? landed.errorLine}`, { refusedBy: "chain", signature: landed.signature, explorer: verdict.explorer });
      return { ...base, status: "refused", reason: landed.errorName ?? landed.errorLine, refusedBy: "chain", sent: true, signature: landed.signature, explorer: verdict.explorer, chainVerdict: verdict };
    }
    log.add("chain", `${label}: verify + ${action.instruction} landed`, { signature: landed.signature, explorer: verdict.explorer });
    return { ...base, status: "executed", sent: true, signature: landed.signature, explorer: verdict.explorer, chainVerdict: verdict };
  }

  return { discoverService, querySubgraph, getMyMandate, requestPayment, requestAction };
}

// ---- what the model is told about the tools ----------------------------------------------------

export interface ToolSpec {
  name: keyof AgentTools;
  description: string;
  input_schema: Record<string, unknown>;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "discoverService",
    description: "Resolve a service by ENS name (rail.endpoint, rail.chain, rail.price, rail.token). The agent starts from names only.",
    input_schema: { type: "object", properties: { ensName: { type: "string", description: "e.g. feed.agentrail.eth" } }, required: ["ensName"] },
  },
  {
    name: "querySubgraph",
    description: "Ask a natural-language question about public on-chain data; another model searches The Graph's published subgraphs and answers with evidence. Use it to discover which protocols a wallet is exposed to and to drill into them.",
    input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  {
    name: "getMyMandate",
    description: "Your own mandate on every chain: caps, spent, remaining, expiry, active flag, permitted instructions, and the live delegation on Alice's account. A fixed query on the AgentRail index.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "requestPayment",
    description:
      "Pay for something. Either a discovered service by ENS name (service, plus symbols for a price feed or query for a GraphQL gateway) or a direct payment on solana:devnet (chain, payTo wallet, amount in base units). The mandate decides; a refusal is final.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "ENS name of the service to buy from" },
        symbols: { type: "array", items: { type: "string" }, description: "price feed symbols, e.g. [\"SOL\",\"HBAR\"]" },
        query: { type: "string", description: "GraphQL query for a gateway service" },
        chain: { type: "string", description: "for a direct payment: solana:devnet" },
        payTo: { type: "string", description: "for a direct payment: the payee wallet (base58)" },
        amount: { type: "string", description: "for a direct payment: amount in base units (USDC has 6 decimals)" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "requestAction",
    description:
      "Run an SPL Token instruction on Alice's delegated USDC account through the mandate's instruction gate (verify): revoke (clear the current delegate), approve (delegate + amount), setAuthority (newAuthority, authorityType AccountOwner|CloseAccount), closeAccount (destination). Never moves value. The mandate lists which instructions are permitted; a refusal is final.",
    input_schema: {
      type: "object",
      properties: {
        instruction: { type: "string", enum: ["revoke", "approve", "setAuthority", "closeAccount"] },
        delegate: { type: "string" },
        amount: { type: "string" },
        newAuthority: { type: "string" },
        authorityType: { type: "string", enum: ["AccountOwner", "CloseAccount"] },
        destination: { type: "string" },
        reason: { type: "string" },
      },
      required: ["instruction"],
    },
  },
];

/** Dispatch a model's tool call to the typed function. Unknown names and bad inputs come back as errors, not crashes. */
export async function callTool(tools: AgentTools, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "discoverService":
      return tools.discoverService(String(input.ensName ?? ""));
    case "querySubgraph":
      return tools.querySubgraph(String(input.question ?? ""));
    case "getMyMandate":
      return tools.getMyMandate();
    case "requestPayment": {
      if (typeof input.service === "string" && input.service) {
        return tools.requestPayment({ service: input.service, symbols: Array.isArray(input.symbols) ? input.symbols.map(String) : undefined, query: typeof input.query === "string" ? input.query : undefined, reason: typeof input.reason === "string" ? input.reason : undefined });
      }
      if (typeof input.payTo === "string" && input.amount !== undefined) {
        return tools.requestPayment({ chain: "solana:devnet", payTo: input.payTo, amount: String(input.amount), asset: typeof input.asset === "string" ? input.asset : undefined, reason: typeof input.reason === "string" ? input.reason : undefined });
      }
      return { error: "requestPayment needs either service (ENS name) or payTo + amount" };
    }
    case "requestAction":
      return tools.requestAction(input as unknown as TokenAction);
    default:
      return { error: `unknown tool ${name}` };
  }
}
