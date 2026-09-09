/**
 * GATE 2 on Hedera testnet: the agent pays for a real service through its mandate, keeps paying,
 * and is then refused by the mandate before any money moves.
 *
 *   owner   EvmMandate.createMandate + addPermission(seller, caps)         Hedera EVM
 *   agent   quote -> authorize (EvmMandate.check + authorize) -> settle     x402 via Blocky402
 *   ...     repeat until the lifetime cap is reached
 *   agent   the next authorize throws MandateRefused; no payment is signed, no request is sent
 *
 * Every settlement is confirmed on the Mirror Node, not on the facilitator's word. Each step is
 * also published to an HCS topic as a verifiable audit trail.
 *
 * Output: scripts/out/hedera.json (gitignored).
 * Run: yarn demo:hedera   (the data feed must be running; FEED_URL points at the paid resource)
 */
import { AccountId, Client, PrivateKey, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { createClientHederaSigner, PrivateKey as X402PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import * as fs from "fs";
import { keccak256, toHex, type Address, type Hex } from "viem";

import { HederaAdapter, MandateRefused, hederaLongZeroAddress, type FetchLike } from "../packages/sdk/src/index.ts";
import { createEvmClients, hederaTestnet, issueEvmMandate } from "../packages/sdk/src/evm/clients.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
};

const MANDATE_CONTRACT = env("EVM_MANDATE_HEDERA") as Address;
const FEED_URL = process.env.FEED_URL ?? "http://localhost:4021/price/SOL,HBAR"; // seam: ENS rail.endpoint in Phase 3
const SPEND_LIMIT = BigInt(process.env.HEDERA_SPEND_LIMIT ?? "50000"); // 0.05 USDC lifetime
const PER_TX_LIMIT = BigInt(process.env.HEDERA_PER_TX_LIMIT ?? "30000"); // 0.03 USDC per call
const USDC = 1_000_000n;
const fmt = (n: bigint) => `${(Number(n) / Number(USDC)).toFixed(6)} USDC`;

/** ENS namehash of databot.agentrail.eth, the join key shared with the Solana mandate. */
const ENS_NODE = (process.env.RAIL_NODE ?? "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae") as Hex;

async function main() {
  // ---- identities ---------------------------------------------------------------------------
  const owner = createEvmClients(hederaTestnet, env("HEDERA_JSON_RPC_URL"), env("DEPLOYER_PRIVATE_KEY") as Hex);
  const agentKey = env("HEDERA_PRIVATE_KEY");
  const agent = createEvmClients(hederaTestnet, env("HEDERA_JSON_RPC_URL"), (agentKey.startsWith("0x") ? agentKey : `0x${agentKey}`) as Hex);
  const agentAccount = env("HEDERA_ACCOUNT_ID");
  const seller = env("HEDERA_SELLER_ACCOUNT_ID");
  const sellerAddress = hederaLongZeroAddress(seller);
  console.log("owner (mandate issuer)", owner.account.address);
  console.log("agent (Hedera EVM)    ", agent.account.address, "=", agentAccount);
  console.log("seller (payTo)        ", seller, "=", sellerAddress);
  console.log("EvmMandate            ", MANDATE_CONTRACT);

  // ---- HCS audit trail ----------------------------------------------------------------------
  const hcs = Client.forTestnet().setOperator(AccountId.fromString(agentAccount), PrivateKey.fromStringECDSA(agentKey));
  let topicId = process.env.HCS_AUDIT_TOPIC_ID;
  if (!topicId) {
    const rx = await (await new TopicCreateTransaction().setTopicMemo("AgentRail audit trail: databot.agentrail.eth").execute(hcs)).getReceipt(hcs);
    topicId = rx.topicId!.toString();
    console.log("HCS topic created     ", topicId, "(add HCS_AUDIT_TOPIC_ID to .env to reuse)");
  }
  const audit = async (event: string, detail: Record<string, unknown>) => {
    const msg = JSON.stringify({ v: 1, agent: "databot.agentrail.eth", event, at: new Date().toISOString(), ...detail });
    const tx = await new TopicMessageSubmitTransaction().setTopicId(topicId!).setMessage(msg).execute(hcs);
    await tx.getReceipt(hcs);
    return tx.transactionId.toString();
  };

  // ---- the owner issues the mandate on Hedera -----------------------------------------------
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const { mandateId, txs: mandateTxs } = await issueEvmMandate(owner, MANDATE_CONTRACT, agent.account.address, ENS_NODE, expiry, {
    destination: sellerAddress,
    spendLimit: SPEND_LIMIT,
    perTxLimit: PER_TX_LIMIT,
  });
  console.log("mandate               ", mandateId, `caps per-tx ${fmt(PER_TX_LIMIT)} lifetime ${fmt(SPEND_LIMIT)}`);
  for (const h of mandateTxs) console.log("   ", `https://hashscan.io/testnet/transaction/${h}`);
  await audit("mandate.issued", { mandateId, spendLimit: SPEND_LIMIT.toString(), perTxLimit: PER_TX_LIMIT.toString(), destination: seller });

  // ---- the agent's adapter; paid requests are counted so a refusal can prove none was sent ---
  let paidRequests = 0;
  const countingFetch: FetchLike = async (url, init) => {
    if (init?.headers?.["X-PAYMENT"]) paidRequests++;
    return fetch(url, init);
  };
  const signer = new ExactHederaScheme(
    createClientHederaSigner(agentAccount, X402PrivateKey.fromStringECDSA(agentKey), { network: "hedera:testnet" }),
  );
  const adapter = new HederaAdapter({ mandateContract: MANDATE_CONTRACT, agent: agent.account.address, client: agent.gate, signer, fetch: countingFetch });
  const mandate = { chain: "hedera:testnet" as const, id: mandateId };

  // ---- pay until the mandate says stop ------------------------------------------------------
  const payments: unknown[] = [];
  let refusal: unknown = null;
  for (let i = 1; i <= 10; i++) {
    const quote = await adapter.quote({ chain: "hedera:testnet", url: FEED_URL });
    console.log(`\n#${i} quote ${fmt(quote.amount)} -> ${quote.payTo} (${quote.asset})`);
    const before = paidRequests;
    try {
      const auth = await adapter.authorize(mandate, quote);
      console.log(`   gate  EvmMandate.authorize https://hashscan.io/testnet/transaction/${(auth.gate as { txHash: string }).txHash}`);
      const done = await adapter.settle(auth);
      const body = done.response as { data?: unknown; payment?: { transactionId?: string }; metering?: unknown };
      const mirror = await confirmOnMirror(done.transactionId);
      console.log(`   paid  ${done.transactionId}  ${mirror ? `${mirror.name} ${mirror.result}` : "not yet on mirror"}`);
      console.log(`   data  ${JSON.stringify(body.data)}`);
      console.log(`   link  ${done.explorer}`);
      const auditTx = await audit("payment.settled", { amount: quote.amount.toString(), transactionId: done.transactionId, gateTx: (auth.gate as { txHash: string }).txHash });
      payments.push({ amount: quote.amount.toString(), gateTx: (auth.gate as { txHash: string }).txHash, transactionId: done.transactionId, hashscan: done.explorer, mirror, data: body.data, metering: body.metering, auditTx });
    } catch (e) {
      if (!(e instanceof MandateRefused)) throw e;
      const spent = payments.reduce((s, p: any) => s + BigInt(p.amount), 0n);
      console.log(`   REFUSED by the mandate: ${e.reason}  (spent ${fmt(spent)} of ${fmt(SPEND_LIMIT)}; next ${fmt(quote.amount)} would breach it)`);
      console.log(`   paid requests sent during this attempt: ${paidRequests - before}  (no payment signed, facilitator never contacted)`);
      const selector = await agent.publicClient.readContract({
        address: MANDATE_CONTRACT,
        abi: (await import("../packages/sdk/src/evm/abi.ts")).EVM_MANDATE_ABI,
        functionName: "check",
        args: [mandateId, agent.account.address, sellerAddress, quote.amount],
      });
      const auditTx = await audit("payment.refused", { reason: e.reason, amount: quote.amount.toString(), selector });
      refusal = { reason: e.reason, selector, amount: quote.amount.toString(), spentBefore: spent.toString(), paidRequestsSent: paidRequests - before, auditTx };
      break;
    }
  }
  if (!refusal) throw new Error("the mandate never refused; check the caps");

  const out = {
    chain: "hedera:testnet",
    evmMandate: MANDATE_CONTRACT,
    mandateId,
    owner: owner.account.address,
    agent: { evm: agent.account.address, account: agentAccount },
    seller: { account: seller, evm: sellerAddress },
    feedUrl: FEED_URL,
    caps: { spendLimit: SPEND_LIMIT.toString(), perTxLimit: PER_TX_LIMIT.toString() },
    mandateTxs: mandateTxs.map((h) => `https://hashscan.io/testnet/transaction/${h}`),
    hcsTopic: { id: topicId, hashscan: `https://hashscan.io/testnet/topic/${topicId}` },
    payments,
    refusal,
  };
  fs.mkdirSync("scripts/out", { recursive: true });
  fs.writeFileSync("scripts/out/hedera.json", JSON.stringify(out, null, 2));
  console.log("\nHCS audit topic", out.hcsTopic.hashscan);
  console.log("wrote scripts/out/hedera.json");
  hcs.close();
}

async function confirmOnMirror(txId: string) {
  const dash = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const m = (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(dash)}`).then((r) => r.json()).catch(() => ({}))) as any;
    const hit = (m.transactions ?? []).find((t: any) => String(t.name).includes("CRYPTOTRANSFER"));
    if (hit) {
      const transfers = (hit.token_transfers?.length ? hit.token_transfers : hit.transfers) ?? [];
      return { name: hit.name, result: hit.result, consensus: hit.consensus_timestamp, transfers: transfers.filter((t: any) => Number(t.amount) !== 0 && !String(t.account).match(/^0\.0\.(3|98|800|801)$/)) };
    }
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
