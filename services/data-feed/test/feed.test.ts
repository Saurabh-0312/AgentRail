import { describe, expect, it, vi } from "vitest";

import { createApp, type FeedConfig } from "../src/app.ts";
import { HEDERA_TESTNET, HTS_USDC_TESTNET, decodePaymentHeader, encodeB64, type Facilitator, type PaymentRequirements } from "../src/x402.ts";

const PAY_TO = "0.0.4864228";
const FEE_PAYER = "0.0.7162784";
const UNIT = 10_000n; // 0.01 USDC

function mockFacilitator(overrides: Partial<Facilitator> = {}) {
  return {
    feePayer: vi.fn(async () => FEE_PAYER),
    verify: vi.fn(async () => ({ isValid: true, payer: "0.0.4863756" })),
    settle: vi.fn(async () => ({ success: true, transaction: "0.0.7162784@1788889346.864779084", payer: "0.0.4863756" })),
    ...overrides,
  } as Facilitator & { verify: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> };
}

function build(facilitator = mockFacilitator(), extra: Partial<FeedConfig> = {}) {
  const app = createApp({
    network: HEDERA_TESTNET,
    asset: HTS_USDC_TESTNET,
    assetSymbol: "USDC",
    assetDecimals: 6,
    unitPrice: UNIT,
    maxSymbols: 5,
    payTo: PAY_TO,
    feePayer: FEE_PAYER,
    resourceBase: "https://feed.example",
    facilitator,
    quotes: async (symbols) =>
      symbols.map((symbol) => ({ symbol, price: 1, currency: "USD" as const, source: "test", fetchedAt: "now" })),
    mirror: async () => null,
    ...extra,
  });
  return { app, facilitator };
}

const paymentHeader = (accepted: PaymentRequirements, payload: unknown = { transaction: "AAAA" }) =>
  encodeB64({ x402Version: 2, scheme: "exact", network: HEDERA_TESTNET, accepted, payload });

async function challenge(app: ReturnType<typeof createApp>, path: string) {
  const res = await app.request(path);
  const body = await res.json();
  return { res, body, requirements: body.accepts?.[0] as PaymentRequirements };
}

describe("402 challenge", () => {
  it("unpaid request returns 402 with a well-formed payment requirement", async () => {
    const { app } = build();
    const { res, body, requirements } = await challenge(app, "/price/SOL");
    expect(res.status).toBe(402);
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe("PAYMENT_REQUIRED");
    expect(requirements).toMatchObject({
      scheme: "exact",
      network: HEDERA_TESTNET,
      asset: HTS_USDC_TESTNET,
      payTo: PAY_TO,
      amount: UNIT.toString(),
      maxTimeoutSeconds: 300,
      resource: "https://feed.example/price/SOL",
      extra: { feePayer: FEE_PAYER },
    });
    // The header carries the same body, base64.
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    expect(JSON.parse(Buffer.from(header!, "base64").toString())).toEqual(body);
  });

  it("meters per query: three symbols cost three units", async () => {
    const { app } = build();
    const { requirements } = await challenge(app, "/price/SOL,HBAR,ETH");
    expect(requirements.amount).toBe((UNIT * 3n).toString());
    expect(requirements.resource).toBe("https://feed.example/price/SOL,HBAR,ETH");
  });

  it("payTo is never the fee payer", async () => {
    const { app } = build();
    const { requirements } = await challenge(app, "/price/SOL");
    expect(requirements.payTo).not.toBe(requirements.extra.feePayer);
  });

  it("rejects unknown, duplicate, or too many symbols with 400, not 402", async () => {
    const { app } = build();
    for (const path of ["/price/XYZ", "/price/SOL,SOL", "/price/SOL,ETH,BTC,HBAR,LINK,AVAX", "/price/,"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(400);
    }
  });

  it("publishes a free price schedule", async () => {
    const { app } = build();
    const res = await app.request("/pricing");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toContain("per-call");
    expect(body.unitPrice).toBe(UNIT.toString());
    expect(body.symbols).toContain("HBAR");
  });
});

describe("payment header validation", () => {
  it("malformed base64 is rejected before the facilitator is contacted", async () => {
    const { app, facilitator } = build();
    const res = await app.request("/price/SOL", { headers: { "X-PAYMENT": "not-base64-json!!" } });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("MALFORMED_X_PAYMENT");
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("valid base64 with the wrong shape is rejected", async () => {
    const { app, facilitator } = build();
    for (const bad of [encodeB64({ hello: "world" }), encodeB64({ x402Version: 1, accepted: {}, payload: {} }), encodeB64("str")]) {
      const res = await app.request("/price/SOL", { headers: { "X-PAYMENT": bad } });
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("MALFORMED_X_PAYMENT");
    }
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("a payment for a different amount, payTo, or asset is rejected without verify", async () => {
    const { app, facilitator } = build();
    const { requirements } = await challenge(app, "/price/SOL");
    const variants = [
      { ...requirements, amount: "1" },
      { ...requirements, payTo: "0.0.1" },
      { ...requirements, asset: "0.0.0" },
      { ...requirements, network: "hedera:mainnet" },
    ];
    for (const accepted of variants) {
      const res = await app.request("/price/SOL", { headers: { "X-PAYMENT": paymentHeader(accepted) } });
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("REQUIREMENTS_MISMATCH");
    }
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("a payment the facilitator cannot verify is refused and never settled", async () => {
    const facilitator = mockFacilitator({ verify: vi.fn(async () => ({ isValid: false, invalidReason: "amount_mismatch" })) });
    const { app } = build(facilitator);
    const { requirements } = await challenge(app, "/price/SOL");
    const res = await app.request("/price/SOL", { headers: { "X-PAYMENT": paymentHeader(requirements) } });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("VERIFY_amount_mismatch");
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});

describe("paid request", () => {
  it("verifies, settles exactly once, returns data and a receipt", async () => {
    const { app, facilitator } = build();
    const { requirements } = await challenge(app, "/price/SOL,HBAR");
    const res = await app.request("/price/SOL,HBAR", { headers: { "X-PAYMENT": paymentHeader(requirements) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((q: { symbol: string }) => q.symbol)).toEqual(["SOL", "HBAR"]);
    expect(body.payment.amount).toBe((UNIT * 2n).toString());
    expect(body.payment.transactionId).toBe("0.0.7162784@1788889346.864779084");
    expect(body.payment.hashscan).toBe("https://hashscan.io/testnet/transaction/0.0.7162784-1788889346-864779084");
    expect(body.metering.symbolsBilled).toBe(2);
    expect(body.metering.callsByPayer).toBe(1);
    expect(res.headers.get("X-Call-Count")).toBe("1");
    const pr = decodePaymentHeader(res.headers.get("X-PAYMENT-RESPONSE")!.replace(/^/, ""));
    expect(pr).toBeNull(); // it is a response object, not a payment payload
    expect(JSON.parse(Buffer.from(res.headers.get("X-PAYMENT-RESPONSE")!, "base64").toString())).toMatchObject({ success: true });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    // verify and settle receive the same payload and the server's own requirements
    const [payload, reqs] = facilitator.settle.mock.calls[0];
    expect(reqs).toEqual(requirements);
    expect(payload.accepted).toEqual(requirements);
  });

  it("the same payment header cannot buy twice", async () => {
    const { app, facilitator } = build();
    const { requirements } = await challenge(app, "/price/SOL");
    const header = paymentHeader(requirements);
    expect((await app.request("/price/SOL", { headers: { "X-PAYMENT": header } })).status).toBe(200);
    const again = await app.request("/price/SOL", { headers: { "X-PAYMENT": header } });
    expect(again.status).toBe(402);
    expect((await again.json()).error).toBe("PAYMENT_ALREADY_USED");
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("meters cumulative spend per payer and exposes receipts", async () => {
    const { app } = build();
    for (const path of ["/price/SOL", "/price/SOL,HBAR"]) {
      const { requirements } = await challenge(app, path);
      const res = await app.request(path, { headers: { "X-PAYMENT": paymentHeader(requirements, { n: path }) } });
      expect(res.status).toBe(200);
    }
    const res = await app.request("/receipts/0.0.4863756");
    const body = await res.json();
    expect(body.calls).toBe(2);
    expect(body.receipts.map((r: { amount: string }) => r.amount)).toEqual([UNIT.toString(), (UNIT * 2n).toString()]);
  });

  it("a settle failure returns 402 and records nothing", async () => {
    const facilitator = mockFacilitator({ settle: vi.fn(async () => ({ success: false, errorReason: "DUPLICATE_TRANSACTION" })) });
    const { app } = build(facilitator);
    const { requirements } = await challenge(app, "/price/SOL");
    const res = await app.request("/price/SOL", { headers: { "X-PAYMENT": paymentHeader(requirements) } });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("SETTLE_DUPLICATE_TRANSACTION");
    expect((await (await app.request("/receipts/0.0.4863756")).json()).calls).toBe(0);
  });

  it("upstream data failure returns 503 and does not settle", async () => {
    const facilitator = mockFacilitator();
    const { app } = build(facilitator, { quotes: async () => { throw new Error("coinbase down"); } });
    const { requirements } = await challenge(app, "/price/SOL");
    const res = await app.request("/price/SOL", { headers: { "X-PAYMENT": paymentHeader(requirements) } });
    expect(res.status).toBe(503);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});
