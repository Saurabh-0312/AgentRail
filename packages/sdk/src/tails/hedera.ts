/**
 * Hedera tail. Gate: `EvmMandate` on Hedera testnet. Rail: x402 through the Blocky402 facilitator.
 *
 *   quote      unpaid GET on the service -> 402 requirements (HTS USDC or HBAR)
 *   authorize  EvmMandate.check -> EvmMandate.authorize (recorded)  THEN sign the exact transfer
 *   settle     retry with X-PAYMENT; the service verifies and settles; Mirror Node is the record
 *
 * The same ECDSA key is the mandate's agent on the Hedera EVM and the x402 payer, so one identity
 * both asks the mandate and pays.
 */
import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";

import { evmGate, type EvmGateClient } from "../evm/gate.ts";
import type { Authorization, FetchLike, MandateRef, PaymentAdapter, PaymentRequirements, Quote, ServiceRef, Settlement } from "../types.ts";
import { CHAINS } from "../types.ts";
import { encodePaymentHeader, fetchQuote, payAndFetch } from "../x402.ts";

/** What @x402/hedera's ExactHederaScheme provides. Injected so tests never build a real transaction. */
export interface HederaPaymentSigner {
  createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<{ payload: unknown }>;
}

export interface HederaAdapterConfig {
  mandateContract: Address;
  /** EVM address of the Hedera account that pays: the mandate's agent on Hedera. */
  agent: Address;
  /** Hedera account id -> EVM address for the 402's payTo. Defaults to the long-zero alias. */
  payToAddress?: (accountId: string) => Address;
  client: EvmGateClient;
  signer: HederaPaymentSigner;
  fetch?: FetchLike;
}

/** `0.0.10440535` -> `0x00000000000000000000000000000000009f4f57` (Hedera long-zero form). */
export function hederaLongZeroAddress(accountId: string): Address {
  const num = BigInt(accountId.split(".")[2]);
  return `0x${num.toString(16).padStart(40, "0")}` as Address;
}

export class HederaAdapter implements PaymentAdapter {
  readonly chain = CHAINS.HEDERA_TESTNET;
  private readonly cfg: HederaAdapterConfig;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: HederaAdapterConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
  }

  quote(service: ServiceRef): Promise<Quote> {
    return fetchQuote(this.fetchImpl, this.chain, service);
  }

  async authorize(mandate: MandateRef, quote: Quote): Promise<Authorization> {
    const destination = (this.cfg.payToAddress ?? hederaLongZeroAddress)(quote.payTo);
    const ref = keccak256(toHex(quote.requirements.resource ?? quote.service.url));
    // The gate. Nothing below this line runs unless the mandate said yes.
    const txHash = await evmGate(
      { chain: this.chain, mandateContract: this.cfg.mandateContract, agent: this.cfg.agent, client: this.cfg.client },
      mandate.id as Hex,
      destination,
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
    if (!authorization.paymentHeader) throw new Error("hedera settle: missing payment header");
    const { body, settlement } = await payAndFetch(this.fetchImpl, authorization.quote.service, authorization.paymentHeader);
    const transactionId =
      settlement.transaction ?? ((body?.payment as { transactionId?: string } | undefined)?.transactionId ?? "");
    const dash = transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
    return {
      chain: this.chain,
      transactionId,
      explorer: `https://hashscan.io/testnet/transaction/${dash}`,
      response: body,
    };
  }
}
