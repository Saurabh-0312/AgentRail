/**
 * Boot the data feed against the Blocky402 facilitator on Hedera testnet.
 *
 * Env (from ../../.env locally, from the host's dashboard when deployed): HEDERA_SELLER_ACCOUNT_ID
 * (payTo; must differ from any buyer), BLOCKY402_URL, FEED_ASSET (HTS USDC 0.0.429274 by default,
 * 0.0.0 for HBAR), FEED_UNIT_PRICE (smallest units per symbol), FEED_PUBLIC_URL (falls back to
 * RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN), PORT, FEED_UNLISTED_PAYTO (demo affordance: the
 * payee `/demo/unlisted/...` challenges name; 0.0.98 by default). No secrets: the facilitator settles.
 */
import { serve } from "@hono/node-server";

import { DEFAULT_UNLISTED_PAYTO, createApp } from "./app.ts";
import { HBAR_ASSET, HEDERA_TESTNET, HTS_USDC_TESTNET, httpFacilitator } from "./x402.ts";

const facilitatorUrl = process.env.BLOCKY402_URL ?? "https://api.testnet.blocky402.com";
const payTo = process.env.HEDERA_SELLER_ACCOUNT_ID;
if (!payTo) {
  console.error("HEDERA_SELLER_ACCOUNT_ID missing (payTo must be a different account from the buyer)");
  process.exit(2);
}
const asset = process.env.FEED_ASSET ?? HTS_USDC_TESTNET;
const isHbar = asset === HBAR_ASSET;
const unitPrice = BigInt(process.env.FEED_UNIT_PRICE ?? (isHbar ? "10000000" : "10000")); // 0.1 HBAR or 0.01 USDC
const port = Number(process.env.PORT ?? 4021);
// Public base URL for the 402 `resource`: explicit, else what the host tells us, else local.
const hostedUrl =
  process.env.FEED_PUBLIC_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
const resourceBase = (hostedUrl ?? `http://localhost:${port}`).replace(/\/$/, "");

const facilitator = httpFacilitator(facilitatorUrl);
const feePayer = await facilitator.feePayer(HEDERA_TESTNET);

const app = createApp({
  network: HEDERA_TESTNET,
  asset,
  assetSymbol: isHbar ? "HBAR" : "USDC",
  assetDecimals: isHbar ? 8 : 6,
  unitPrice,
  maxSymbols: Number(process.env.FEED_MAX_SYMBOLS ?? 5),
  payTo,
  feePayer,
  resourceBase,
  facilitator,
  unlistedPayTo: process.env.FEED_UNLISTED_PAYTO ?? DEFAULT_UNLISTED_PAYTO,
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`agentrail data-feed on ${resourceBase}`);
  console.log(`  network=${HEDERA_TESTNET} asset=${asset} unitPrice=${unitPrice} payTo=${payTo} feePayer=${feePayer}`);
  console.log(`  facilitator=${facilitatorUrl}`);
});
