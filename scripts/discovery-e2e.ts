/**
 * GATE 3: the agent starts with an ENS name and nothing else. No URL, no API key, no price.
 *
 *   1. resolve its own name: rail.allowed (what the mandate lets it buy), rail.agent.* (its keys)
 *   2. resolve feed.agentrail.eth  -> rail.chain selects HederaAdapter -> allow-list -> mandate -> pay
 *   3. resolve graph.agentrail.eth -> rail.chain selects BaseAdapter   -> allow-list -> mandate -> pay
 *   4. a discovered service that is NOT on rail.allowed is refused before any payment step
 *   5. the Base mandate's lifetime cap refuses the next query before any money moves
 *
 * One mandate name governs two shops on two chains. Every refusal happens before a facilitator is
 * contacted. Output: scripts/out/discovery.json (gitignored).
 *
 * Env: SEPOLIA_RPC_URL, HEDERA_JSON_RPC_URL, BASE_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY (owner),
 * HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY (Hedera agent), AGENT_EVM_PRIVATE_KEY (Base agent),
 * EVM_MANDATE_HEDERA, EVM_MANDATE_BASE_SEPOLIA, RAIL_NODE. No service URL, no API key.
 * Run: yarn demo:discovery
 */
import { createClientHederaSigner, PrivateKey as X402PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import * as fs from "fs";
import { keccak256, toHex, type Address, type Hex } from "viem";

import {
  AdapterRegistry,
  BaseAdapter,
  CHAINS,
  HederaAdapter,
  MandateRefused,
  NotOnAllowList,
  SettlementFailed,
  assertAllowed,
  discoverService,
  hederaLongZeroAddress,
  parseAllowed,
  type DiscoveredService,
  type FetchLike,
  type MandateRef,
  type PaymentAdapter,
} from "../packages/sdk/src/index.ts";
import { createEvmClients, hederaTestnet, baseSepolia, issueEvmMandate } from "../packages/sdk/src/evm/clients.ts";
import { sepoliaEnsReader } from "../packages/sdk/src/ens.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
};
const hex = (k: string) => (env(k).startsWith("0x") ? env(k) : `0x${env(k)}`) as Hex;

// The agent knows three names. That is all it knows.
const AGENT_NAME = process.env.AGENT_ENS_NAME ?? "databot.agentrail.eth";
const SERVICES = (process.env.SERVICE_ENS_NAMES ?? "feed.agentrail.eth,graph.agentrail.eth").split(",");
const ENS_NODE = env("RAIL_NODE") as Hex;

const out: Record<string, unknown> = { agent: AGENT_NAME, services: {}, payments: [], refusals: [] };
const payments = out.payments as unknown[];
const refusals = out.refusals as unknown[];

// Every outbound call is counted, so a refusal can prove that nothing was sent after it.
let paidRequests = 0;
const countingFetch: FetchLike = async (url, init) => {
  if (init?.headers?.["X-PAYMENT"] || init?.headers?.["PAYMENT-SIGNATURE"]) paidRequests++;
  return fetch(url, init);
};

function show(title: string, records: Record<string, string>) {
  console.log(`\n${title}`);
  for (const [k, v] of Object.entries(records)) console.log(`   ${k.padEnd(26)} ${v}`);
}

/** What each discovered service is asked for. A Graph gateway endpoint needs a GraphQL body; the feed is a GET. */
function requestFor(service: DiscoveredService) {
  if (/\/(subgraphs|deployments)\/id\//.test(service.url)) {
    return {
      url: service.url,
      request: { method: "POST" as const, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ _meta { block { number } } shinkaiIdentities(first: 3, orderBy: stakedTokens, orderDirection: desc) { identityRaw stakedTokens delegatedTokens createdAt } }" }) },
    };
  }
  if (service.name.startsWith("feed.")) return { url: `${service.url.replace(/\/$/, "")}/price/SOL,HBAR` };
  return { url: service.url };
}

async function main() {
  const readText = sepoliaEnsReader(env("SEPOLIA_RPC_URL"));

  // ---- 1. the agent resolves itself -----------------------------------------------------------
  const self: Record<string, string> = {};
  for (const k of ["rail.agent.solana", "rail.agent.hedera", "rail.agent.base", "rail.erc8004", "rail.allowed"]) {
    self[k] = (await readText(AGENT_NAME, k)) ?? "";
  }
  show(`${AGENT_NAME} (the mandate name)`, self);
  const allowed = parseAllowed(self["rail.allowed"], AGENT_NAME);

  // ---- identities and mandates on each chain ---------------------------------------------------
  const ownerHedera = createEvmClients(hederaTestnet, env("HEDERA_JSON_RPC_URL"), hex("DEPLOYER_PRIVATE_KEY"));
  const ownerBase = createEvmClients(baseSepolia, env("BASE_SEPOLIA_RPC_URL"), hex("DEPLOYER_PRIVATE_KEY"));
  const agentHedera = createEvmClients(hederaTestnet, env("HEDERA_JSON_RPC_URL"), hex("HEDERA_PRIVATE_KEY"));
  const agentBase = createEvmClients(baseSepolia, env("BASE_SEPOLIA_RPC_URL"), hex("AGENT_EVM_PRIVATE_KEY"));
  if (agentHedera.account.address.toLowerCase() !== self["rail.agent.hedera"].toLowerCase()) throw new Error("Hedera key does not match rail.agent.hedera");
  if (agentBase.account.address.toLowerCase() !== self["rail.agent.base"].toLowerCase()) throw new Error("Base key does not match rail.agent.base");

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const capsFor = (chain: string, target: string) => {
    const e = allowed.find((a) => a.chain === chain && a.target.toLowerCase() === target.toLowerCase());
    if (!e?.perTx || !e?.total) throw new Error(`rail.allowed has no caps for ${chain} ${target}`);
    return { perTxLimit: BigInt(e.perTx), spendLimit: BigInt(e.total) };
  };
  const hederaEntry = allowed.find((a) => a.chain === CHAINS.HEDERA_TESTNET)!;
  const baseEntry = allowed.find((a) => a.chain === CHAINS.BASE_SEPOLIA)!;
  const hederaMandate = await issueEvmMandate(ownerHedera, env("EVM_MANDATE_HEDERA") as Address, agentHedera.account.address, ENS_NODE, expiry, {
    destination: hederaLongZeroAddress(hederaEntry.target),
    ...capsFor(CHAINS.HEDERA_TESTNET, hederaEntry.target),
  });
  const baseMandate = await issueEvmMandate(ownerBase, env("EVM_MANDATE_BASE_SEPOLIA") as Address, agentBase.account.address, ENS_NODE, expiry, {
    destination: baseEntry.target as Address,
    ...capsFor(CHAINS.BASE_SEPOLIA, baseEntry.target),
  });
  console.log(`\nmandates issued from rail.allowed caps: hedera ${hederaMandate.mandateId} · base ${baseMandate.mandateId}`);
  out.mandates = { hedera: hederaMandate, base: baseMandate };

  const mandates: Record<string, MandateRef> = {
    [CHAINS.HEDERA_TESTNET]: { chain: CHAINS.HEDERA_TESTNET, id: hederaMandate.mandateId },
    [CHAINS.BASE_SEPOLIA]: { chain: CHAINS.BASE_SEPOLIA, id: baseMandate.mandateId },
  };

  // ---- adapters, selected by rail.chain, never by a constant in the demo path ------------------
  const registry = new AdapterRegistry()
    .register(CHAINS.HEDERA_TESTNET, () => new HederaAdapter({
      mandateContract: env("EVM_MANDATE_HEDERA") as Address,
      agent: agentHedera.account.address,
      client: agentHedera.gate,
      signer: new ExactHederaScheme(createClientHederaSigner(env("HEDERA_ACCOUNT_ID"), X402PrivateKey.fromStringECDSA(env("HEDERA_PRIVATE_KEY")), { network: "hedera:testnet" })),
      fetch: countingFetch,
    }))
    .register(CHAINS.BASE_SEPOLIA, () => new BaseAdapter({
      mandateContract: env("EVM_MANDATE_BASE_SEPOLIA") as Address,
      agent: agentBase.account.address,
      client: agentBase.gate,
      signer: new ExactEvmScheme(toClientEvmSigner(agentBase.account as any, agentBase.publicClient as any)),
      fetch: countingFetch,
    }));

  const explorerFor = (chain: string, tx: string) =>
    chain === CHAINS.HEDERA_TESTNET ? `https://hashscan.io/testnet/transaction/${tx}` : `https://sepolia.basescan.org/tx/${tx}`;

  /** discover -> allow-list -> quote -> authorize (gate) -> settle. Returns false when refused. */
  async function buy(name: string, expectRefusal?: string) {
    const service = await discoverService(name, readText);
    show(`${name} (discovered)`, service.records);
    (out.services as Record<string, unknown>)[name] = service.records;
    const adapter: PaymentAdapter = registry.select(service.chain);
    console.log(`   -> rail.chain=${service.chain} selects ${adapter.constructor.name}`);
    const ref = { chain: service.chain, ...requestFor(service) };
    const before = paidRequests;
    try {
      const quote = await adapter.quote(ref);
      console.log(`   402 quote ${quote.amount} units of ${quote.asset} to ${quote.payTo}`);
      assertAllowed(allowed, service, quote.payTo); // discovery is not authorization
      const auth = await adapter.authorize(mandates[service.chain], quote);
      const gate = auth.gate.kind === "evm-authorize" ? auth.gate.txHash : "";
      console.log(`   gate  EvmMandate.authorize ${explorerFor(service.chain, gate)}`);
      const done = await adapter.settle(auth);
      const body = done.response as Record<string, unknown>;
      const data = (body?.data ?? body) as unknown;
      console.log(`   paid  ${done.transactionId}  ${done.explorer}`);
      console.log(`   data  ${JSON.stringify(data).slice(0, 220)}`);
      payments.push({ service: name, chain: service.chain, amount: quote.amount.toString(), payTo: quote.payTo, gateTx: gate, transactionId: done.transactionId, explorer: done.explorer, data });
      if (expectRefusal) throw new Error(`${name}: expected refusal ${expectRefusal}`);
      return true;
    } catch (e) {
      if (e instanceof NotOnAllowList || e instanceof MandateRefused) {
        const reason = e instanceof NotOnAllowList ? "NotOnAllowList" : e.reason;
        console.log(`   REFUSED ${reason}: ${e.message}`);
        console.log(`   paid requests sent during this attempt: ${paidRequests - before}`);
        refusals.push({ service: name, chain: service.chain, reason, paidRequestsSent: paidRequests - before });
        if (expectRefusal && expectRefusal !== reason) throw new Error(`${name}: expected ${expectRefusal}, got ${reason}`);
        if (!expectRefusal) throw e;
        return false;
      }
      throw e;
    }
  }

  /** A facilitator can fail to land a transaction; retry the whole purchase (fresh gate, fresh signature). */
  const buyWithRetry = async (name: string, expectRefusal?: string, attempts = 3) => {
    for (let i = 1; ; i++) {
      try {
        return await buy(name, expectRefusal);
      } catch (e) {
        if (e instanceof SettlementFailed && i < attempts) {
          console.log(`   settlement failed at the facilitator (${JSON.stringify((e as SettlementFailed).body)}); retrying in 8s`);
          await new Promise((r) => setTimeout(r, 8000));
          continue;
        }
        throw e;
      }
    }
  };

  // ---- 2 + 3. two shops, two chains, one mandate name -----------------------------------------
  for (const name of SERVICES) await buyWithRetry(name);

  // ---- 4. discovered but not allowed: the owner has not listed this payee ---------------------
  // A name that resolves perfectly well but whose payee is not in rail.allowed. The agent refuses
  // itself before the mandate, before the facilitator, before anything is signed.
  const rogueName = process.env.ROGUE_ENS_NAME ?? "rogue.agentrail.eth";
  await buyWithRetry(rogueName, "NotOnAllowList");

  // ---- 5. the cap: keep buying from The Graph until the Base mandate says stop -----------------
  const graphName = SERVICES.find((n) => n.startsWith("graph")) ?? SERVICES[1];
  for (let i = 0; i < 5; i++) {
    const ok = await buyWithRetry(graphName, undefined).catch((e) => {
      if (e instanceof MandateRefused) return false;
      throw e;
    });
    if (!ok) break;
  }
  const lastRefusal = refusals[refusals.length - 1] as { reason: string };
  if (lastRefusal?.reason !== "SpendLimitExceeded" && lastRefusal?.reason !== "PerTxLimitExceeded") {
    throw new Error("the Base mandate never refused; check rail.allowed caps");
  }

  out.summary = { payments: payments.length, refusals: refusals.length, paidRequestsTotal: paidRequests, apiKeysUsed: 0 };
  fs.mkdirSync("scripts/out", { recursive: true });
  fs.writeFileSync("scripts/out/discovery.json", JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\n${payments.length} payments on ${new Set(payments.map((p: any) => p.chain)).size} chains, ${refusals.length} refusals, 0 API keys. wrote scripts/out/discovery.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
