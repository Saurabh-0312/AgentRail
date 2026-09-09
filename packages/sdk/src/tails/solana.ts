/**
 * Solana tail. Gate and rail are the same instruction: `execute_payment`.
 *
 * The agent holds no tokens and no delegation, so it cannot sign an x402 SPL transfer at all.
 * Instead `authorize` reads the mandate, refuses locally if the caps would be breached, and builds
 * the `execute_payment` transaction in which the mandate PDA signs as the SPL delegate. `settle`
 * submits it. On this chain the program is the settlement rail; a facilitator is optional and
 * would only ever pay the fee.
 *
 *   quote      unpaid GET -> 402 (Blocky402 serves solana devnet) or a direct price
 *   authorize  mandate PDA read -> local gate -> signed execute_payment tx (unsent)
 *   settle     sendRawTransaction + confirm; the on-chain check runs again, atomically
 */
import { MandateRefused } from "../errors.ts";
import type { Authorization, FetchLike, MandateRef, PaymentAdapter, Quote, ServiceRef, Settlement } from "../types.ts";
import { CHAINS } from "../types.ts";
import { fetchQuote, payAndFetch } from "../x402.ts";

/** A decoded permission entry, in the layout the program uses. */
export interface SolanaPermission {
  key: string; // base58: destination token account for payments
  spendLimit: bigint;
  perTxLimit: bigint;
  spendTotal: bigint;
}

export interface SolanaMandateState {
  active: boolean;
  expiry: bigint; // unix seconds
  agent: string; // base58
  permissions: SolanaPermission[];
}

/** The chain surface the tail needs. The default implementation wraps Anchor + web3.js. */
export interface SolanaGateClient {
  readMandate(mandate: string): Promise<SolanaMandateState | null>;
  /** Owner-of-`payTo`'s token account for the quoted asset: the destination `execute_payment` checks. */
  destinationTokenAccount(payTo: string, asset: string): Promise<string>;
  buildExecutePayment(mandate: string, destination: string, amount: bigint): Promise<Uint8Array>;
  send(signedTransaction: Uint8Array): Promise<string>;
  now(): Promise<bigint>;
}

export interface SolanaAdapterConfig {
  agent: string; // base58
  client: SolanaGateClient;
  fetch?: FetchLike;
}

/** The same fail-fast order as `checks.rs`, run locally so an over-cap request never leaves the process. */
export function solanaLocalGate(m: SolanaMandateState | null, now: bigint, agent: string, destination: string, amount: bigint) {
  if (!m || !m.active) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "NotActive");
  if (now >= m.expiry) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "Expired");
  if (m.agent !== agent) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "NotTheAgent");
  const p = m.permissions.find((x) => x.key === destination);
  if (!p) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "DestinationNotAllowed");
  if (p.perTxLimit !== 0n && amount > p.perTxLimit) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "PerTxLimitExceeded");
  if (p.spendLimit !== 0n && p.spendTotal + amount > p.spendLimit) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "SpendLimitExceeded");
  return p;
}

export class SolanaAdapter implements PaymentAdapter {
  readonly chain = CHAINS.SOLANA_DEVNET;
  private readonly cfg: SolanaAdapterConfig;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: SolanaAdapterConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
  }

  quote(service: ServiceRef): Promise<Quote> {
    return fetchQuote(this.fetchImpl, this.chain, service);
  }

  async authorize(mandate: MandateRef, quote: Quote): Promise<Authorization> {
    const destination = await this.cfg.client.destinationTokenAccount(quote.payTo, quote.asset);
    const [state, now] = await Promise.all([this.cfg.client.readMandate(mandate.id), this.cfg.client.now()]);
    solanaLocalGate(state, now, this.cfg.agent, destination, quote.amount); // throws before anything is built
    const signedTransaction = await this.cfg.client.buildExecutePayment(mandate.id, destination, quote.amount);
    return { chain: this.chain, quote, mandate, gate: { kind: "solana-execute-payment" }, signedTransaction };
  }

  async settle(authorization: Authorization): Promise<Settlement> {
    if (!authorization.signedTransaction) throw new Error("solana settle: missing signed transaction");
    const signature = await this.cfg.client.send(authorization.signedTransaction);
    let response: unknown;
    // If the resource is x402-gated, hand it the on-chain settlement as proof.
    if (authorization.quote.requirements.scheme === "exact" && authorization.quote.service.url.startsWith("http")) {
      const header = Buffer.from(
        JSON.stringify({ x402Version: 2, scheme: "exact", network: authorization.quote.requirements.network, accepted: authorization.quote.requirements, payload: { transaction: signature } }),
      ).toString("base64");
      response = await payAndFetch(this.fetchImpl, authorization.quote.service.url, header).then((r) => r.body).catch((e) => ({ error: String(e) }));
    }
    return {
      chain: this.chain,
      transactionId: signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      response,
    };
  }
}
