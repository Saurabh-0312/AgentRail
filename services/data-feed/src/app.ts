/**
 * The shop. `GET /price/:symbols` is x402-gated and metered per query: the amount owed is
 * `unitPrice x number of symbols`, so a three-symbol request costs three units. The 402 challenge
 * states the exact amount for that query, the buyer signs a Hedera transfer for it, and the
 * service verifies then settles through the facilitator, once.
 */
import { Hono } from "hono";

import { type QuoteFetcher, SUPPORTED_SYMBOLS, liveQuotes, parseSymbols } from "./quotes.ts";
import {
  type Facilitator,
  type MirrorConfirmation,
  type PaymentRequirements,
  decodePaymentHeader,
  encodeB64,
  hashscanUrl,
  mirrorConfirm,
} from "./x402.ts";

export interface FeedConfig {
  network: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
  /** Price of one symbol, in the asset's smallest unit. */
  unitPrice: bigint;
  maxSymbols: number;
  payTo: string;
  feePayer: string;
  /** Public base URL, used in the 402 `resource` field. */
  resourceBase: string;
  facilitator: Facilitator;
  /**
   * DEMO AFFORDANCE. Default payee for `/demo/unlisted/price/:symbols`, a route that issues a
   * well-formed 402 whose payee is deliberately not the shop's, so an agent's allow-list can be
   * shown refusing a service that resolves and answers correctly. That route never settles.
   */
  unlistedPayTo?: string;
  quotes?: QuoteFetcher;
  mirror?: (txId: string) => Promise<MirrorConfirmation | null>;
}

/** The Hedera fee-collection account: real on every Hedera network, never anyone's shop. */
export const DEFAULT_UNLISTED_PAYTO = "0.0.98";

export interface Receipt {
  payer: string;
  transactionId: string;
  amount: string;
  symbols: string[];
  at: string;
}

export function createApp(cfg: FeedConfig) {
  const quotes = cfg.quotes ?? liveQuotes;
  const mirror = cfg.mirror ?? mirrorConfirm;
  const ledger = new Map<string, Receipt[]>(); // pay-per-call metering, keyed by payer account
  const settledTx = new Set<string>(); // a payment payload is settled at most once

  const requirementsFor = (symbols: string[], payTo = cfg.payTo, resource = `${cfg.resourceBase}/price/${symbols.join(",")}`): PaymentRequirements => ({
    scheme: "exact",
    network: cfg.network,
    amount: (cfg.unitPrice * BigInt(symbols.length)).toString(),
    payTo,
    asset: cfg.asset,
    maxTimeoutSeconds: 300,
    resource,
    description: `${symbols.length} spot price${symbols.length > 1 ? "s" : ""} (${symbols.join(", ")}) at ${cfg.unitPrice} ${cfg.assetSymbol} units each`,
    extra: { feePayer: cfg.feePayer },
  });

  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, network: cfg.network, asset: cfg.asset, payTo: cfg.payTo, feePayer: cfg.feePayer }),
  );

  /** Free: the price schedule, so an agent can budget before it pays. */
  app.get("/pricing", (c) =>
    c.json({
      model: "per-call, metered by query",
      unit: "one symbol",
      unitPrice: cfg.unitPrice.toString(),
      asset: cfg.asset,
      assetSymbol: cfg.assetSymbol,
      assetDecimals: cfg.assetDecimals,
      network: cfg.network,
      maxSymbols: cfg.maxSymbols,
      symbols: SUPPORTED_SYMBOLS,
      example: { path: "/price/SOL,HBAR", amount: (cfg.unitPrice * 2n).toString() },
    }),
  );

  app.get("/price/:symbols", async (c) => {
    const symbols = parseSymbols(c.req.param("symbols"), cfg.maxSymbols);
    if (!symbols) {
      return c.json({ error: "BAD_SYMBOLS", supported: SUPPORTED_SYMBOLS, maxSymbols: cfg.maxSymbols }, 400);
    }
    const requirements = requirementsFor(symbols);
    const deny = (error: string, extra?: Record<string, unknown>) => {
      const body = { x402Version: 2, error, accepts: [requirements], ...(extra ?? {}) };
      c.header("PAYMENT-REQUIRED", encodeB64(body));
      return c.json(body, 402);
    };

    const raw = c.req.header("X-PAYMENT") ?? c.req.header("PAYMENT-SIGNATURE");
    if (!raw) return deny("PAYMENT_REQUIRED");
    const paymentPayload = decodePaymentHeader(raw);
    if (!paymentPayload) return deny("MALFORMED_X_PAYMENT");

    // The buyer echoes the requirements it accepted; they must match this query exactly.
    const a = paymentPayload.accepted;
    if (
      a.amount !== requirements.amount ||
      a.payTo !== requirements.payTo ||
      a.asset !== requirements.asset ||
      a.network !== requirements.network
    ) {
      return deny("REQUIREMENTS_MISMATCH");
    }
    if (settledTx.has(raw)) return deny("PAYMENT_ALREADY_USED");

    const v = await cfg.facilitator.verify(paymentPayload, requirements);
    if (!v.isValid) return deny(`VERIFY_${v.invalidReason ?? "FAILED"}`, { facilitator: v });

    // Fetch the data before settling: a paid request must never return an empty body.
    let data;
    try {
      data = await quotes(symbols);
    } catch (e) {
      return c.json({ error: "UPSTREAM_UNAVAILABLE", detail: String(e) }, 503);
    }

    const s = await cfg.facilitator.settle(paymentPayload, requirements);
    if (!s.success) return deny(`SETTLE_${s.errorReason ?? "FAILED"}`, { facilitator: s });
    settledTx.add(raw);

    const txId = s.transaction ?? s.transactionId ?? "";
    const payer = s.payer ?? v.payer ?? "unknown";
    const receipt: Receipt = { payer, transactionId: txId, amount: requirements.amount, symbols, at: new Date().toISOString() };
    const history = ledger.get(payer) ?? [];
    history.push(receipt);
    ledger.set(payer, history);
    const confirmation = txId ? await mirror(txId) : null;

    c.header("X-PAYMENT-RESPONSE", encodeB64({ success: true, transaction: txId, network: cfg.network, payer }));
    c.header("X-Call-Count", String(history.length));
    return c.json({
      data,
      payment: {
        payer,
        payTo: cfg.payTo,
        amount: requirements.amount,
        asset: cfg.asset,
        assetSymbol: cfg.assetSymbol,
        network: cfg.network,
        transactionId: txId,
        hashscan: txId ? hashscanUrl(txId) : null,
        mirrorNode: confirmation, // null until the Mirror Node has indexed it; poll /receipts
      },
      metering: {
        symbolsBilled: symbols.length,
        unitPrice: cfg.unitPrice.toString(),
        callsByPayer: history.length,
        spentByPayer: history.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString(),
      },
    });
  });

  /**
   * DEMO AFFORDANCE, not a shop. Prices exactly like `/price/:symbols`, except the payee is
   * `?payTo=` (else `unlistedPayTo`): a well-formed 402 for a payee no mandate has listed. It
   * exists so "discovery is not authorization" can be shown deterministically, with no third
   * party in the loop: the name resolves, the service answers correctly, and the agent still
   * refuses. This route never verifies or settles anything.
   */
  app.get("/demo/unlisted/price/:symbols", (c) => {
    const symbols = parseSymbols(c.req.param("symbols"), cfg.maxSymbols);
    if (!symbols) {
      return c.json({ error: "BAD_SYMBOLS", supported: SUPPORTED_SYMBOLS, maxSymbols: cfg.maxSymbols }, 400);
    }
    const payTo = c.req.query("payTo") ?? cfg.unlistedPayTo ?? DEFAULT_UNLISTED_PAYTO;
    const resource = `${cfg.resourceBase}/demo/unlisted/price/${symbols.join(",")}?payTo=${payTo}`;
    const paid = c.req.header("X-PAYMENT") ?? c.req.header("PAYMENT-SIGNATURE");
    const body = {
      x402Version: 2,
      error: paid ? "DEMO_ROUTE_NEVER_SETTLES" : "PAYMENT_REQUIRED",
      accepts: [requirementsFor(symbols, payTo, resource)],
      demo: "unlisted payee: this route issues challenges only and never settles a payment",
    };
    c.header("PAYMENT-REQUIRED", encodeB64(body));
    return c.json(body, 402);
  });

  /** Free: what a payer has bought so far. The audit trail the Mirror Node can be checked against. */
  app.get("/receipts/:payer", (c) => {
    const history = ledger.get(c.req.param("payer")) ?? [];
    return c.json({ payer: c.req.param("payer"), calls: history.length, receipts: history });
  });

  return app;
}
