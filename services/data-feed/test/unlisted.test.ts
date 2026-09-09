/**
 * The demo affordance: `/demo/unlisted/price/:symbols` answers a well-formed 402 for a payee that
 * is not the shop's, so "discovery is not authorization" can be shown without a third party.
 */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_UNLISTED_PAYTO, createApp, type FeedConfig } from "../src/app.ts";
import { HEDERA_TESTNET, HTS_USDC_TESTNET, encodeB64, type Facilitator, type PaymentRequirements } from "../src/x402.ts";

const PAY_TO = "0.0.4864228";
const FEE_PAYER = "0.0.7162784";
const UNIT = 10_000n;

function build(extra: Partial<FeedConfig> = {}) {
  const facilitator = {
    feePayer: vi.fn(async () => FEE_PAYER),
    verify: vi.fn(async () => ({ isValid: true, payer: "0.0.4863756" })),
    settle: vi.fn(async () => ({ success: true, transaction: "0.0.7162784@1.2", payer: "0.0.4863756" })),
  } as Facilitator & { verify: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> };
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
    quotes: async (symbols) => symbols.map((symbol) => ({ symbol, price: 1, currency: "USD" as const, source: "test", fetchedAt: "now" })),
    mirror: async () => null,
    ...extra,
  });
  return { app, facilitator };
}

async function challenge(app: ReturnType<typeof createApp>, path: string) {
  const res = await app.request(path);
  const body = await res.json();
  return { res, body, requirements: body.accepts?.[0] as PaymentRequirements };
}

describe("/demo/unlisted (discovery is not authorization)", () => {
  it("issues a well-formed 402 for the unlisted payee, on the same rail at the same price", async () => {
    const { app } = build();
    const { res, body, requirements } = await challenge(app, "/demo/unlisted/price/SOL,HBAR");
    expect(res.status).toBe(402);
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe("PAYMENT_REQUIRED");
    expect(requirements).toMatchObject({
      scheme: "exact",
      network: HEDERA_TESTNET,
      asset: HTS_USDC_TESTNET,
      payTo: DEFAULT_UNLISTED_PAYTO,
      amount: (UNIT * 2n).toString(),
      maxTimeoutSeconds: 300,
      resource: `https://feed.example/demo/unlisted/price/SOL,HBAR?payTo=${DEFAULT_UNLISTED_PAYTO}`,
      extra: { feePayer: FEE_PAYER },
    });
    expect(requirements.payTo).not.toBe(PAY_TO);
    // Same shape as the real route: the header carries the body, base64.
    expect(JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString())).toEqual(body);
    // The real route still pays the shop.
    expect((await challenge(app, "/price/SOL,HBAR")).requirements.payTo).toBe(PAY_TO);
  });

  it("?payTo= picks the payee; config sets the default", async () => {
    const { app } = build({ unlistedPayTo: "0.0.1234" });
    expect((await challenge(app, "/demo/unlisted/price/SOL")).requirements.payTo).toBe("0.0.1234");
    expect((await challenge(app, "/demo/unlisted/price/SOL?payTo=0.0.777")).requirements.payTo).toBe("0.0.777");
    expect((await challenge(app, "/demo/unlisted/price/SOL?payTo=0.0.777")).requirements.resource).toBe("https://feed.example/demo/unlisted/price/SOL?payTo=0.0.777");
  });

  it("never verifies or settles, even when handed a payment; bad symbols are still 400", async () => {
    const { app, facilitator } = build();
    const { requirements } = await challenge(app, "/demo/unlisted/price/SOL");
    const header = encodeB64({ x402Version: 2, scheme: "exact", network: HEDERA_TESTNET, accepted: requirements, payload: { transaction: "AAAA" } });
    for (const name of ["X-PAYMENT", "PAYMENT-SIGNATURE"]) {
      const res = await app.request("/demo/unlisted/price/SOL", { headers: { [name]: header } });
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("DEMO_ROUTE_NEVER_SETTLES");
    }
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect((await app.request("/demo/unlisted/price/XYZ")).status).toBe(400);
  });
});
