/**
 * A quote for a shop that has no HTTP front: the price is known (from config today, from an ENS
 * service record in Phase 3) and settlement is the chain itself. The Solana devnet demo uses this;
 * `settle` skips the paid-request step for non-http service refs.
 */
import type { ChainId, Quote, ServiceRef } from "./types.ts";
import { X402_NETWORK } from "./types.ts";

export interface DirectQuoteInput {
  chain: ChainId;
  /** Opaque locator, e.g. `agentrail://shop/<name>`; must not start with http. */
  resource: string;
  amount: bigint;
  asset: string;
  payTo: string;
}

export function directQuote(q: DirectQuoteInput): Quote {
  if (q.resource.startsWith("http")) throw new Error("directQuote is for non-HTTP shops; use adapter.quote() for x402 services");
  const service: ServiceRef = { chain: q.chain, url: q.resource };
  return {
    chain: q.chain,
    service,
    amount: q.amount,
    asset: q.asset,
    payTo: q.payTo,
    requirements: {
      scheme: "exact",
      network: X402_NETWORK[q.chain],
      amount: q.amount.toString(),
      payTo: q.payTo,
      asset: q.asset,
      resource: q.resource,
      extra: {},
    },
  };
}
