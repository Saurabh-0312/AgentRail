/** x402 v2 client-side pieces shared by the service-settled tails (Hedera, Base). */
import { BadChallenge, SettlementFailed } from "./errors.ts";
import type { ChainId, FetchLike, PaymentRequirements, Quote, ServiceRef } from "./types.ts";
import { X402_NETWORK } from "./types.ts";

/** Unpaid GET -> 402 -> the requirement for our chain. This talks to the service, never a facilitator. */
const requestInit = (service: ServiceRef, extraHeaders: Record<string, string> = {}) => ({
  method: service.request?.method ?? "GET",
  headers: { ...(service.request?.headers ?? {}), ...extraHeaders },
  ...(service.request?.body !== undefined ? { body: service.request.body } : {}),
});

export async function fetchQuote(fetchImpl: FetchLike, chain: ChainId, service: ServiceRef): Promise<Quote> {
  const res = await fetchImpl(service.url, requestInit(service));
  type Challenge = { x402Version?: number; accepts?: PaymentRequirements[] };
  // x402 v2 carries the challenge in the PAYMENT-REQUIRED header; the JSON body is optional.
  const header = res.headers.get("PAYMENT-REQUIRED");
  const text = await res.text().catch(() => "");
  let body: Challenge | null = null;
  try {
    body = text ? (JSON.parse(text) as Challenge) : null;
  } catch {
    body = null;
  }
  if (!body?.accepts?.length && header) {
    try {
      body = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Challenge;
    } catch {
      body = null;
    }
  }
  if (res.status !== 402 || !body?.accepts?.length) {
    throw new BadChallenge(`expected a 402 challenge from ${service.url}, got ${res.status}`, res.status, body);
  }
  const network = X402_NETWORK[chain];
  const requirements = body.accepts.find((r) => r.network === network && r.scheme === "exact");
  if (!requirements) {
    throw new BadChallenge(`service does not accept ${network}`, res.status, body);
  }
  return {
    chain,
    service,
    amount: BigInt(requirements.amount),
    asset: requirements.asset,
    payTo: requirements.payTo,
    requirements,
  };
}

export const encodePaymentHeader = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64");

/**
 * Retry the resource with the payment attached. The service verifies and settles through its
 * facilitator. Both header spellings are sent: `PAYMENT-SIGNATURE` (x402 v2) and `X-PAYMENT` (v1,
 * still accepted by Blocky402-style servers).
 */
export async function payAndFetch(fetchImpl: FetchLike, service: ServiceRef, paymentHeader: string) {
  const res = await fetchImpl(service.url, requestInit(service, { "PAYMENT-SIGNATURE": paymentHeader, "X-PAYMENT": paymentHeader }));
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status !== 200) {
    throw new SettlementFailed(`service returned ${res.status}: ${(body as { error?: string })?.error ?? "unknown"}`, body);
  }
  const responseHeader = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  const settlement = responseHeader
    ? (JSON.parse(Buffer.from(responseHeader, "base64").toString("utf8")) as { transaction?: string; payer?: string })
    : {};
  return { body, settlement };
}
