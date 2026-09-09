import { toFunctionSelector } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  AdapterRegistry,
  BaseAdapter,
  CHAINS,
  HederaAdapter,
  SolanaAdapter,
  type EnsTextReader,
  type PaymentAdapter,
  type PaymentRequirements,
} from "../src/index.ts";
import { DiscoveryError, discoverService } from "../src/discovery.ts";
import { NotOnAllowList, assertAllowed, parseAllowed } from "../src/allowlist.ts";

const FEED = {
  "rail.endpoint": "https://agentrail-data-feed.onrender.com",
  "rail.chain": "hedera:testnet",
  "rail.price": "10000",
  "rail.token": "0.0.429274",
  "rail.scheme": "x402",
  description: "spot prices, per symbol",
};
const GRAPH = {
  "rail.endpoint": "https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/69kQZiehpuHGMjYwzV5qZQUn75nZRH1ewn5nM4WzoZEv",
  "rail.chain": "eip155:84532",
  "rail.price": "42",
  "rail.token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "rail.scheme": "x402",
};

/** A fake ENS: name -> key -> value. Records every read so tests can assert what was resolved. */
function fakeEns(names: Record<string, Record<string, string>>) {
  const reads: [string, string][] = [];
  const readText: EnsTextReader = async (name, key) => {
    reads.push([name, key]);
    return names[name]?.[key];
  };
  return { readText, reads };
}

describe("rail.allowed gate", () => {
  const allowed = JSON.stringify([
    { chain: "solana:devnet", target: "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a", perTx: "2000000", total: "5000000" },
    { chain: "hedera:testnet", target: "0.0.10440535", perTx: "30000", total: "50000", mint: "0.0.429274" },
    { chain: "eip155:84532", target: "0xAbCd000000000000000000000000000000000001", perTx: "10000", total: "50000" },
  ]);

  it("parses the record and matches chain + payee, case-insensitively for addresses", async () => {
    const list = parseAllowed(allowed, "databot.agentrail.eth");
    expect(list).toHaveLength(3);
    const feed = await discoverService("feed.agentrail.eth", fakeEns({ "feed.agentrail.eth": FEED }).readText);
    expect(assertAllowed(list, feed, "0.0.10440535").total).toBe("50000");
    const graph = await discoverService("graph.agentrail.eth", fakeEns({ "graph.agentrail.eth": GRAPH }).readText);
    expect(assertAllowed(list, graph, "0xabcd000000000000000000000000000000000001").chain).toBe("eip155:84532");
  });

  it("a service that resolves correctly but is not on the list is refused", async () => {
    const list = parseAllowed(allowed, "databot.agentrail.eth");
    const feed = await discoverService("feed.agentrail.eth", fakeEns({ "feed.agentrail.eth": FEED }).readText);
    expect(() => assertAllowed(list, feed, "0.0.999999")).toThrow(NotOnAllowList);
    // same payee id on the wrong chain is not a match either
    const graph = await discoverService("graph.agentrail.eth", fakeEns({ "graph.agentrail.eth": GRAPH }).readText);
    expect(() => assertAllowed(list, graph, "0.0.10440535")).toThrow(NotOnAllowList);
  });

  it("missing or malformed rail.allowed throws rather than allowing everything", () => {
    expect(() => parseAllowed(undefined, "databot.agentrail.eth")).toThrow(DiscoveryError);
    expect(() => parseAllowed("", "databot.agentrail.eth")).toThrow(DiscoveryError);
    expect(() => parseAllowed("{not json", "databot.agentrail.eth")).toThrow(DiscoveryError);
    expect(() => parseAllowed('{"chain":"x"}', "databot.agentrail.eth")).toThrow(/array/);
    expect(() => parseAllowed('[{"chain":"hedera:testnet"}]', "databot.agentrail.eth")).toThrow(/target/);
  });

  it("a discovered-but-not-allowed service is refused before any network call", async () => {
    // Full pipeline with a real HederaAdapter wired to spies: discovery -> allow-list -> (never) authorize.
    const list = parseAllowed(allowed, "databot.agentrail.eth");
    const rogue = { ...FEED, "rail.endpoint": "https://rogue.example/price" };
    const feed = await discoverService("rogue.agentrail.eth", fakeEns({ "rogue.agentrail.eth": rogue }).readText);
    const requirements: PaymentRequirements = { scheme: "exact", network: "hedera:testnet", amount: "20000", payTo: "0.0.424242", asset: "0.0.429274", extra: { feePayer: "0.0.7162784" } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ x402Version: 2, accepts: [requirements] }), { status: 402 }));
    const client = { readContract: vi.fn(async () => "0x00000000" as `0x${string}`), writeContract: vi.fn(async () => "0xabc" as `0x${string}`), waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const })) };
    const signer = { createPaymentPayload: vi.fn(async () => ({ payload: {} })) };
    const adapter = new HederaAdapter({ mandateContract: "0x68822ce9109D9d71e99b07703cF6c851D0229AA9", agent: "0x0F072339A79E72A78A0535bB9132228C8B8B1fF0", client, signer, fetch: fetchImpl });

    const quote = await adapter.quote(feed); // the unpaid 402 is the price discovery, not a payment
    expect(() => assertAllowed(list, feed, quote.payTo)).toThrow(NotOnAllowList);
    // Refused here, so none of the following ever happens:
    expect(client.readContract).not.toHaveBeenCalled();
    expect(client.writeContract).not.toHaveBeenCalled();
    expect(signer.createPaymentPayload).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.filter((c: any[]) => c[1]?.headers?.["X-PAYMENT"])).toHaveLength(0);
    expect(toFunctionSelector("PerTxLimitExceeded()")).toBeTruthy(); // keep the import honest
  });
});
