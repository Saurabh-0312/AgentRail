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
 *
 * The instruction gate (`verify`, SPEC §8.1.1) has the same shape: `solanaLocalVerifyGate` mirrors
 * verify.rs locally, `buildVerifiedInstruction` pairs the sibling instruction with `verify`, and
 * `land` reports the chain's verdict together with the signature, refusal or not.
 */
import { MandateRefused } from "../errors.ts";
import type { Authorization, FetchLike, MandateRef, PaymentAdapter, Quote, ServiceRef, Settlement } from "../types.ts";
import { CHAINS } from "../types.ts";
import { fetchQuote, payAndFetch } from "../x402.ts";

/** A decoded permission entry, in the layout the program uses. */
export interface SolanaPermission {
  /** base58. Destination token account for payments, program id for `verify`: the key the entry is filed under (SPEC §8.1.1). */
  key: string;
  spendLimit: bigint;
  perTxLimit: bigint;
  spendTotal: bigint;
  /** Instruction-keyed entries: allowed discriminators as hex, left-aligned in 8 bytes, and their width (1, 4 or 8). */
  discriminators?: string[];
  discriminatorSize?: number;
}

/** The instruction the agent wants to run under `verify`: the sibling the program reads from the sysvar. */
export interface SiblingInstruction {
  programId: string; // base58
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  /** Raw instruction data; the discriminator is its prefix. */
  data: Uint8Array;
}

/** What the chain said about a submitted transaction. */
export interface LandedTransaction {
  signature: string;
  failed: boolean;
  /** The program log line naming the error, or the raw error when the log has none; empty on success. */
  errorLine: string;
  /** Anchor error number (6006 InstructionNotAllowed, 6016 DestinationNotAllowed, ...) when the log carries one. */
  errorCode: number | null;
  errorName: string | null;
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
  /**
   * `[verify(1, declaredAmount), sibling]` in one transaction, signed by the agent and the fee payer.
   * `verify` reads the sibling out of the instructions sysvar, so what it checks is what executes.
   */
  buildVerifiedInstruction(mandate: string, sibling: SiblingInstruction, declaredAmount: bigint): Promise<Uint8Array>;
  /** Submit and throw on a chain refusal. */
  send(signedTransaction: Uint8Array): Promise<string>;
  /** Submit and report the chain's verdict without throwing, so a refusal is recorded with its signature. */
  land(signedTransaction: Uint8Array): Promise<LandedTransaction>;
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

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** SPL Token instruction tags a mandate can list: the 1-byte discriminator `verify` compares. */
export const SPL_TOKEN_TAG = {
  transfer: 3,
  approve: 4,
  revoke: 5,
  setAuthority: 6,
  burn: 8,
  closeAccount: 9,
  transferChecked: 12,
  approveChecked: 13,
} as const;

/** Mirror of `spl_token_amount` in verify.rs: the amount carried by `[tag, u64 LE, ..]` token instructions. */
export function splTokenAmount(programId: string, data: Uint8Array): bigint | null {
  if ((programId !== SPL_TOKEN_PROGRAM && programId !== SPL_TOKEN_2022_PROGRAM) || data.length < 9) return null;
  if (![3, 4, 8, 12, 13, 15].includes(data[0])) return null;
  let v = 0n;
  for (let i = 8; i >= 1; i--) v = (v << 8n) | BigInt(data[i]);
  return v;
}

/** Mirror of `discriminator_allowed` in checks.rs: only the first `discriminatorSize` bytes are compared. */
export function discriminatorAllowed(p: SolanaPermission, data: Uint8Array): boolean {
  const n = p.discriminatorSize ?? 0;
  if (![1, 4, 8].includes(n) || data.length < n) return false;
  const head = Buffer.from(data.subarray(0, n)).toString("hex");
  return (p.discriminators ?? []).some((d) => d.replace(/^0x/, "").slice(0, n * 2) === head);
}

/**
 * The same fail-fast order as `verify`: live -> agent -> program -> discriminator -> caps. Run locally
 * so a forbidden instruction never leaves the process; the chain runs the same checks again,
 * atomically, when the transaction is sent.
 */
export function solanaLocalVerifyGate(m: SolanaMandateState | null, now: bigint, agent: string, sibling: SiblingInstruction, declaredAmount: bigint) {
  if (!m || !m.active) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "NotActive");
  if (now >= m.expiry) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "Expired");
  if (m.agent !== agent) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "NotTheAgent");
  const p = m.permissions.find((x) => x.key === sibling.programId);
  if (!p) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "ProgramNotAllowed", { program: sibling.programId });
  if (!discriminatorAllowed(p, sibling.data)) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "InstructionNotAllowed", { program: sibling.programId, tag: sibling.data[0] });
  const amount = splTokenAmount(sibling.programId, sibling.data) ?? declaredAmount;
  if (p.perTxLimit !== 0n && amount > p.perTxLimit) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "PerTxLimitExceeded");
  if (p.spendLimit !== 0n && p.spendTotal + amount > p.spendLimit) throw new MandateRefused(CHAINS.SOLANA_DEVNET, "SpendLimitExceeded");
  return { permission: p, amount };
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
      response = await payAndFetch(this.fetchImpl, authorization.quote.service, header).then((r) => r.body).catch((e) => ({ error: String(e) }));
    }
    return {
      chain: this.chain,
      transactionId: signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      response,
    };
  }
}
