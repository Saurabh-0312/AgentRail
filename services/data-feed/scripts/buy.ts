/**
 * Reference buyer: unpaid GET -> 402 -> sign the exact Hedera transfer with @x402/hedera ->
 * retry with X-PAYMENT -> confirm on the Mirror Node.
 * The buyer never calls /settle. Only the service does, exactly once.
 *
 * Run (from services/data-feed): node --env-file=../../.env scripts/buy.ts [url]
 */
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const url = process.argv[2] ?? process.env.FEED_URL ?? "http://localhost:4021/price/SOL,HBAR";
const accountId = process.env.HEDERA_ACCOUNT_ID!;
const pk = process.env.HEDERA_PRIVATE_KEY!;

console.log("1) unpaid GET", url);
let res = await fetch(url);
const challenge = await res.json();
if (res.status !== 402) {
  console.error("expected 402, got", res.status, JSON.stringify(challenge));
  process.exit(2);
}
const requirements = challenge.accepts[0];
console.log("   402:", JSON.stringify({ amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo, feePayer: requirements.extra.feePayer }));

console.log("2) sign exact transfer as", accountId);
const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(pk), { network: "hedera:testnet" });
const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements);
const paymentPayload = { x402Version: 2, scheme: "exact", network: "hedera:testnet", accepted: requirements, payload: signed.payload };
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

console.log("3) retry with X-PAYMENT");
res = await fetch(url, { headers: { "X-PAYMENT": xPayment } });
const body = await res.json();
console.log("   status", res.status);
if (res.status !== 200) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(2);
}
console.log("   data:", JSON.stringify(body.data));
console.log("   payment:", JSON.stringify(body.payment));
console.log("   metering:", JSON.stringify(body.metering));

const txId: string = body.payment.transactionId;
const dash = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
console.log("4) Mirror Node confirmation for", txId);
let confirmed = null;
for (let i = 0; i < 12 && !confirmed; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const m = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(dash)}`)
    .then((r) => r.json())
    .catch(() => ({}));
  confirmed = (m.transactions ?? []).find((t: any) => String(t.name).includes("CRYPTOTRANSFER")) ?? null;
}
if (!confirmed) {
  console.error("   not visible on the Mirror Node after 36s");
  process.exit(2);
}
const transfers = (confirmed.token_transfers?.length ? confirmed.token_transfers : confirmed.transfers) ?? [];
console.log(`   ${confirmed.name} ${confirmed.result} consensus=${confirmed.consensus_timestamp} fee=${confirmed.charged_tx_fee}`);
for (const t of transfers) {
  if (t.account === accountId || t.account === requirements.payTo) {
    console.log(`   ${t.account} ${Number(t.amount) > 0 ? "+" : ""}${t.amount}${t.token_id ? " " + t.token_id : " tinybar"}`);
  }
}
console.log("   HashScan:", `https://hashscan.io/testnet/transaction/${dash}`);
