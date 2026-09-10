/**
 * Adapters: from what the tools return to what the rules see. Deterministic, no model.
 *
 *   fromMandateView   the agent's own delegated account, from the fixed query + live account read:
 *                     the current delegate as an approval, recent execute_payment rows as
 *                     transfers, the balance as the denominator
 *   parse*            the drill answers: querySubgraph is asked to answer in a fixed JSON shape;
 *                     these validate and coerce it, and drop what does not fit
 *   fromMessari*      raw rows in the Messari lending schema, for fixtures from real subgraphs
 *   priceInUSD        fill amountUSD from the prices the agent bought
 */
import type { MandateView } from "../tools.ts";
import type { ApprovalEvent, Balance, LendingPosition, TransferEvent } from "./types.ts";

export const USDC_DECIMALS = 6;

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** The first JSON object in a model answer, fences and prose tolerated. null when there is none. */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    if (start < 0) continue;
    // walk to the matching brace so trailing prose does not break the parse
    let depth = 0;
    let inString = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(c.slice(start, i + 1));
            return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export interface DiscoveredProtocol {
  name: string;
  kind: string;
  chain: string;
  subgraphId?: string;
  evidence?: string;
}

/** Discovery pass answer: {"protocols":[{name, kind, chain, subgraphId, evidence}]}. */
export function parseProtocols(text: string): DiscoveredProtocol[] {
  const j = extractJson(text);
  return arr(j?.protocols)
    .map((p) => ({ name: str(p.name) ?? "", kind: str(p.kind) ?? "other", chain: str(p.chain) ?? "eip155:1", subgraphId: str(p.subgraphId), evidence: str(p.evidence) }))
    .filter((p) => p.name);
}

/** Positions drill: {"positions":[{protocol, chain, collateralUSD, debtUSD, healthFactor, liquidationThreshold}]}. */
export function parsePositions(text: string, source: string): LendingPosition[] {
  const j = extractJson(text);
  return arr(j?.positions)
    .map((p) => ({
      protocol: str(p.protocol) ?? "unknown",
      chain: str(p.chain) ?? "eip155:1",
      healthFactor: num(p.healthFactor) ?? null,
      collateralUSD: num(p.collateralUSD),
      debtUSD: num(p.debtUSD),
      liquidationThreshold: num(p.liquidationThreshold),
      source,
    }))
    .filter((p) => p.healthFactor !== null || p.collateralUSD !== undefined || p.debtUSD !== undefined);
}

/** Approvals drill: {"approvals":[{token, tokenSymbol, spender, amount, unlimited, timestamp, spenderTxCount, spenderKnown, spenderLabel}], "tried":[...]}. */
export function parseApprovals(text: string, owner: string, chain: string, source: string): { approvals: ApprovalEvent[]; tried: string[] } {
  const j = extractJson(text);
  const approvals = arr(j?.approvals)
    .map((a): ApprovalEvent | null => {
      const spender = str(a.spender);
      const token = str(a.token);
      const timestamp = num(a.timestamp);
      if (!spender || !token || timestamp === undefined) return null;
      const amount = str(a.amount) ?? "0";
      const txCount = num(a.spenderTxCount);
      const known = bool(a.spenderKnown);
      const label = str(a.spenderLabel);
      const history = txCount !== undefined || known !== undefined || label ? { txCount: txCount ?? null, known, label } : undefined;
      return { chain: str(a.chain) ?? chain, token, tokenSymbol: str(a.tokenSymbol), owner, spender, amount: /^\d+$/.test(amount) ? amount : "0", unlimited: bool(a.unlimited), timestamp, spenderHistory: history, source };
    })
    .filter((a): a is ApprovalEvent => a !== null);
  return { approvals, tried: (Array.isArray(j?.tried) ? j!.tried : []).map(String) };
}

/** Transfers drill: {"transfers":[{token, tokenSymbol, amount, amountUSD, from, to, timestamp}], "balances":[{token, tokenSymbol, amount, amountUSD}], "tried":[...]}. */
export function parseTransfers(text: string, wallet: string, chain: string, source: string): { transfers: TransferEvent[]; balances: Balance[]; tried: string[] } {
  const j = extractJson(text);
  const transfers = arr(j?.transfers)
    .map((t): TransferEvent | null => {
      const token = str(t.token);
      const amount = num(t.amount);
      const to = str(t.to);
      const timestamp = num(t.timestamp);
      if (!token || amount === undefined || !to || timestamp === undefined) return null;
      return { chain: str(t.chain) ?? chain, token, tokenSymbol: str(t.tokenSymbol), amount, amountUSD: num(t.amountUSD), from: str(t.from) ?? wallet, to, timestamp, source };
    })
    .filter((t): t is TransferEvent => t !== null);
  const balances = arr(j?.balances)
    .map((b): Balance | null => {
      const token = str(b.token);
      const amount = num(b.amount);
      if (!token || amount === undefined) return null;
      return { chain: str(b.chain) ?? chain, token, tokenSymbol: str(b.tokenSymbol), amount, amountUSD: num(b.amountUSD), source };
    })
    .filter((b): b is Balance => b !== null);
  return { transfers, balances, tried: (Array.isArray(j?.tried) ? j!.tried : []).map(String) };
}

/**
 * The agent's own delegated account, from getMyMandate. The live delegate is an approval; the
 * mandate PDA is the one delegate Alice set on purpose, so anything else is a spender she did not
 * choose. Recent execute_payment rows are the outflows; the balance is the denominator.
 */
export function fromMandateView(view: MandateView, opts: { now: number; ownerWallet: string; windowSec?: number; chain?: string; decimals?: number }): { approvals: ApprovalEvent[]; transfers: TransferEvent[]; balances: Balance[] } {
  const chain = opts.chain ?? "solana:devnet";
  const decimals = opts.decimals ?? USDC_DECIMALS;
  const scale = 10 ** decimals;
  const windowSec = opts.windowSec ?? 86_400;
  const approvals: ApprovalEvent[] = [];
  const transfers: TransferEvent[] = [];
  const balances: Balance[] = [];
  const d = view.solana?.delegation;
  if (d) {
    balances.push({ chain, token: d.account, tokenSymbol: "USDC", amount: Number(d.balance) / scale, amountUSD: Number(d.balance) / scale, source: "getMyMandate.delegation" });
    if (d.delegate && !d.delegateIsMandate) {
      approvals.push({
        chain,
        token: d.account,
        tokenSymbol: "USDC",
        owner: opts.ownerWallet,
        spender: d.delegate,
        amount: d.delegatedAmount,
        timestamp: opts.now, // observed live: the delegation is in force right now
        spenderHistory: { txCount: d.delegateTxCount ?? null, known: false },
        source: "getMyMandate.delegation",
      });
    }
  }
  const sol = view.chains.find((c) => c.chain === "solana");
  void sol; // actions are not in the view; the history rows below carry them
  for (const row of view.recentActions ?? []) {
    if (row.chain !== "solana" || !row.allowed || row.kind !== "execute_payment") continue;
    if (row.timestamp < opts.now - windowSec) continue;
    transfers.push({ chain, token: d?.account ?? "delegated-account", tokenSymbol: "USDC", amount: Number(row.amount) / scale, amountUSD: Number(row.amount) / scale, from: d?.account ?? "delegated-account", to: row.target, timestamp: row.timestamp, source: "getMyMandate.history" });
  }
  return { approvals, transfers, balances };
}

/** Fill amountUSD from bought prices, by token symbol, where the source did not give one. */
export function priceInUSD<T extends { tokenSymbol?: string; amount: number; amountUSD?: number }>(rows: T[], prices: Record<string, number>): T[] {
  const lookup = (sym?: string) => {
    if (!sym) return undefined;
    const s = sym.toUpperCase().replace(/^W/, "");
    return prices[sym.toUpperCase()] ?? prices[s];
  };
  return rows.map((r) => (typeof r.amountUSD === "number" ? r : lookup(r.tokenSymbol) !== undefined ? { ...r, amountUSD: r.amount * lookup(r.tokenSymbol)! } : r));
}

// ---- raw subgraph shapes, for fixtures -----------------------------------------------------------

/** One `account` in the Messari lending schema (Aave V2/V3 subgraphs): positions with side, balance and market. */
export interface MessariAccount {
  id: string;
  positions: {
    side: "COLLATERAL" | "BORROWER" | "LENDER" | string;
    balance: string;
    market: { name?: string; inputToken: { symbol: string; decimals: number; lastPriceUSD?: string }; liquidationThreshold?: string; inputTokenPriceUSD?: string };
  }[];
}

/** Collateral, debt and a balance-weighted liquidation threshold from a Messari account row. */
export function fromMessariAccount(account: MessariAccount, protocol: string, chain: string, source: string): LendingPosition {
  let collateralUSD = 0;
  let debtUSD = 0;
  let weighted = 0;
  for (const p of account.positions ?? []) {
    const decimals = Number(p.market.inputToken.decimals ?? 18);
    const amount = Number(p.balance) / 10 ** decimals;
    const price = Number(p.market.inputTokenPriceUSD ?? p.market.inputToken.lastPriceUSD ?? 0);
    const usd = amount * price;
    if (p.side === "BORROWER") debtUSD += usd;
    else if (p.side === "COLLATERAL" || p.side === "LENDER") {
      collateralUSD += usd;
      // Messari stores the threshold in percent (e.g. 82.5)
      weighted += usd * (Number(p.market.liquidationThreshold ?? 0) / 100);
    }
  }
  return { protocol, chain, healthFactor: null, collateralUSD, debtUSD, liquidationThreshold: collateralUSD > 0 ? weighted / collateralUSD : undefined, source };
}

/** Rows shaped like an ERC-20 approvals subgraph: { owner, spender, value, blockTimestamp, contract }. */
export function fromApprovalRows(rows: { id?: string; owner: string; spender: string; value: string; blockTimestamp: string | number; contract?: string; token?: { id: string; symbol?: string } }[], chain: string, source: string): ApprovalEvent[] {
  return rows.map((r) => ({ chain, token: r.token?.id ?? r.contract ?? "", tokenSymbol: r.token?.symbol, owner: r.owner, spender: r.spender, amount: r.value, timestamp: Number(r.blockTimestamp), source }));
}

/** Rows shaped like an ERC-20 transfers subgraph: { from, to, value, blockTimestamp, contract, token }. */
export function fromTransferRows(rows: { from: string; to: string; value: string; blockTimestamp: string | number; contract?: string; token?: { id: string; symbol?: string; decimals?: number }; valueUSD?: string }[], chain: string, source: string): TransferEvent[] {
  return rows.map((r) => {
    const decimals = Number(r.token?.decimals ?? 18);
    return { chain, token: r.token?.id ?? r.contract ?? "", tokenSymbol: r.token?.symbol, amount: Number(r.value) / 10 ** decimals, amountUSD: r.valueUSD !== undefined ? Number(r.valueUSD) : undefined, from: r.from, to: r.to, timestamp: Number(r.blockTimestamp), source };
  });
}
