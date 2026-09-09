/**
 * Base Sepolia tail. Gate: `EvmMandate` on Base Sepolia. Rail: x402 "exact" on EVM, an EIP-3009
 * `transferWithAuthorization` over USDC that the service's facilitator (Coinbase) submits.
 * This is the tail The Graph's pay-per-query gateway will use in Phase 3.
 *
 *   quote      unpaid GET -> 402 requirements (USDC on eip155:84532)
 *   authorize  EvmMandate.check -> EvmMandate.authorize  THEN sign the EIP-3009 authorization
 *   settle     retry with X-PAYMENT; the facilitator submits the transfer
 */
import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";

import { evmGate, type EvmGateClient } from "../evm/gate.ts";
import type { Authorization, FetchLike, MandateRef, PaymentAdapter, PaymentRequirements, Quote, ServiceRef, Settlement } from "../types.ts";
import { CHAINS } from "../types.ts";
import { encodePaymentHeader, fetchQuote, payAndFetch } from "../x402.ts";

/** What @x402/evm's ExactEvmScheme provides. */
export interface EvmPaymentSigner {
  createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<{ payload: unknown }>;
}

export interface BaseAdapterConfig {
  mandateContract: Address;
  agent: Address;
  client: EvmGateClient;
  signer: EvmPaymentSigner;
  fetch?: FetchLike;
}

export class BaseAdapter implements PaymentAdapter {
  readonly chain = CHAINS.BASE_SEPOLIA;
  private readonly cfg: BaseAdapterConfig;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: BaseAdapterConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
  }

  quote(service: ServiceRef): Promise<Quote> {
    return fetchQuote(this.fetchImpl, this.chain, service);
  }

  async authorize(mandate: MandateRef, quote: Quote): Promise<Authorization> {
    const ref = keccak256(toHex(quote.requirements.resource ?? quote.service.url));
    const txHash = await evmGate(
      { chain: this.chain, mandateContract: this.cfg.mandateContract, agent: this.cfg.agent, client: this.cfg.client },
      mandate.id as Hex,
      quote.payTo as Address,
      quote.amount,
      ref,
    );
    const signed = await this.cfg.signer.createPaymentPayload(2, quote.requirements);
    const paymentHeader = encodePaymentHeader({
      x402Version: 2,
      scheme: "exact",
      network: quote.requirements.network,
      accepted: quote.requirements,
      payload: signed.payload,
    });
    return { chain: this.chain, quote, mandate, gate: { kind: "evm-authorize", txHash }, paymentHeader };
  }

  async settle(authorization: Authorization): Promise<Settlement> {
    if (!authorization.paymentHeader) throw new Error("base settle: missing payment header");
    const { body, settlement } = await payAndFetch(this.fetchImpl, authorization.quote.service, authorization.paymentHeader);
    const transactionId = settlement.transaction ?? "";
    return {
      chain: this.chain,
      transactionId,
      explorer: `https://sepolia.basescan.org/tx/${transactionId}`,
      response: body,
    };
  }
}
