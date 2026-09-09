/**
 * The payment adapter (SPEC §8.6). One integration with three tails, not three integrations.
 *
 *   quote(service)              what does it cost, in what, on which chain
 *   authorize(mandate, quote)   THE GATE. The mandate decides before any facilitator is contacted.
 *   settle(authorization)       the facilitator (or the chain itself) finishes the payment
 *
 * `chain` is the string that will come from the ENS `rail.chain` record in Phase 3. Nothing in
 * this package hardcodes a service URL; a ServiceRef is resolved elsewhere and handed in.
 */

/** CAIP-2 style chain ids. These are the values `rail.chain` carries. */
export type ChainId = "solana:devnet" | "hedera:testnet" | "eip155:84532";

export const CHAINS = {
  SOLANA_DEVNET: "solana:devnet" as const,
  HEDERA_TESTNET: "hedera:testnet" as const,
  BASE_SEPOLIA: "eip155:84532" as const,
};

/** x402 network strings differ from our chain ids only for Solana. */
export const X402_NETWORK: Record<ChainId, string> = {
  "solana:devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "hedera:testnet": "hedera:testnet",
  "eip155:84532": "eip155:84532",
};

/** How to call the paid resource. GET with no body unless the service says otherwise. */
export interface ServiceRequest {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
}

/** A paid resource, as discovered from ENS (`rail.endpoint`) plus how to call it. */
export interface ServiceRef {
  chain: ChainId;
  /** Full URL of the paid resource, e.g. https://feed/price/SOL,HBAR */
  url: string;
  request?: ServiceRequest;
}

/** The mandate that must approve the spend. Which fields apply depends on the chain. */
export interface MandateRef {
  chain: ChainId;
  /** Solana: base58 PDA. EVM: bytes32 mandate id. */
  id: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  description?: string;
  extra?: Record<string, unknown>;
}

export interface Quote {
  chain: ChainId;
  service: ServiceRef;
  /** Smallest units of `asset`. */
  amount: bigint;
  asset: string;
  payTo: string;
  /** The exact 402 requirements the service will accept back. */
  requirements: PaymentRequirements;
}

/** Proof that the gate passed, plus whatever the settlement step needs. */
export interface Authorization {
  chain: ChainId;
  quote: Quote;
  mandate: MandateRef;
  /** Where the gate ran: an EVM tx hash for `EvmMandate.authorize`, or "execute_payment" on Solana. */
  gate: { kind: "evm-authorize"; txHash: string } | { kind: "solana-execute-payment" };
  /** Base64 X-PAYMENT header (Hedera, Base). */
  paymentHeader?: string;
  /** Signed, unsent transaction bytes (Solana). */
  signedTransaction?: Uint8Array;
}

export interface Settlement {
  chain: ChainId;
  /** Chain transaction id: Hedera `0.0.x@s.n`, EVM hash, Solana signature. */
  transactionId: string;
  explorer: string;
  /** The paid response body, when settlement happened through a service. */
  response?: unknown;
}

export interface PaymentAdapter {
  readonly chain: ChainId;
  quote(service: ServiceRef): Promise<Quote>;
  authorize(mandate: MandateRef, quote: Quote): Promise<Authorization>;
  settle(authorization: Authorization): Promise<Settlement>;
}

/** Minimal fetch surface so tests can prove no network call happened. */
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
