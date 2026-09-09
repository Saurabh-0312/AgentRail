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

describe("discoverService", () => {
  it("returns endpoint, price, token, chain and scheme from the five rail.* records", async () => {
    const ens = fakeEns({ "feed.agentrail.eth": FEED });
    const s = await discoverService("feed.agentrail.eth", ens.readText);
    expect(s).toMatchObject({
      name: "feed.agentrail.eth",
      chain: "hedera:testnet",
      url: "https://agentrail-data-feed.onrender.com",
      price: 10000n,
      token: "0.0.429274",
      scheme: "x402",
      description: "spot prices, per symbol",
    });
    expect(s.records["rail.endpoint"]).toBe(FEED["rail.endpoint"]);
    expect(ens.reads.map(([, k]) => k)).toEqual(["rail.endpoint", "rail.chain", "rail.price", "rail.token", "rail.scheme", "description"]);
  });

  it("rail.chain drives adapter selection: eip155:84532 selects BaseAdapter, hedera:testnet HederaAdapter", async () => {
    const ens = fakeEns({ "feed.agentrail.eth": FEED, "graph.agentrail.eth": GRAPH });
    const registry = new AdapterRegistry()
      .register(CHAINS.HEDERA_TESTNET, () => ({ chain: CHAINS.HEDERA_TESTNET } as unknown as HederaAdapter))
      .register(CHAINS.BASE_SEPOLIA, () => ({ chain: CHAINS.BASE_SEPOLIA } as unknown as BaseAdapter))
      .register(CHAINS.SOLANA_DEVNET, () => ({ chain: CHAINS.SOLANA_DEVNET } as unknown as SolanaAdapter));

    const feed = await discoverService("feed.agentrail.eth", ens.readText);
    const graph = await discoverService("graph.agentrail.eth", ens.readText);
    const pick = (s: { chain: string }): PaymentAdapter => registry.select(s.chain);
    expect(pick(feed).chain).toBe("hedera:testnet");
    expect(pick(graph).chain).toBe("eip155:84532");
  });

  for (const key of ["rail.endpoint", "rail.chain", "rail.price", "rail.token", "rail.scheme"] as const) {
    it(`missing ${key} throws DiscoveryError and does not default`, async () => {
      const records = { ...FEED } as Record<string, string>;
      delete records[key];
      const ens = fakeEns({ "feed.agentrail.eth": records });
      const err = await discoverService("feed.agentrail.eth", ens.readText).catch((e) => e);
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).key).toBe(key);
    });
  }

  it("an unregistered name throws on the first record", async () => {
    const ens = fakeEns({});
    await expect(discoverService("nope.agentrail.eth", ens.readText)).rejects.toMatchObject({ key: "rail.endpoint" });
  });

  it("malformed records throw: bad URL, unknown chain, non-integer price, unknown scheme", async () => {
    const cases: [Partial<typeof FEED>, string][] = [
      [{ "rail.endpoint": "not a url" }, "rail.endpoint"],
      [{ "rail.endpoint": "ftp://feed" }, "rail.endpoint"],
      [{ "rail.chain": "eip155:1" }, "rail.chain"],
      [{ "rail.chain": "hedera" }, "rail.chain"],
      [{ "rail.price": "0.01" }, "rail.price"],
      [{ "rail.price": "10000 USDC" }, "rail.price"],
      [{ "rail.scheme": "stripe" }, "rail.scheme"],
    ];
    for (const [patch, key] of cases) {
      const ens = fakeEns({ "feed.agentrail.eth": { ...FEED, ...patch } });
      const err = await discoverService("feed.agentrail.eth", ens.readText).catch((e) => e);
      expect(err, JSON.stringify(patch)).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).key).toBe(key);
    }
  });
});
