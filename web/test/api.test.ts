import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Mandate } from "@agentrail/query/src/history.ts";

import { CHAINS, chainFromCaip, errorName, errorReason } from "../lib/chains";
import { classify, looksLikeName, normalizeName, payeeInEndpoint } from "../lib/ens";
import { amountFor, headroom, truncate, untilExpiry, usdc } from "../lib/format";

// the live Solana tail reads the public RPC; the route test must not touch the network
vi.mock("../lib/solana-live", () => ({ solanaTail: async () => ({ fromSlot: 496178133, throughSlot: 496178133, fetchedAt: "2026-09-12T00:00:00.000Z", signatures: 0, rows: [], error: "not read in tests" }) }));

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";
const SHOP = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";

beforeAll(() => {
  // the server env the route needs; a fake key so nothing real is touched
  vi.stubEnv("GRAPH_API_KEY", "test-key-not-real-1234567890");
  vi.stubEnv("SUBGRAPH_SEPOLIA_URL", "https://studio.test/sepolia");
  vi.stubEnv("SUBGRAPH_BASE_URL", "https://studio.test/base");
});

const studioMandate = (chain: string): Mandate => ({
  id: `${NODE}:${chain}`,
  chain,
  ensNode: NODE,
  ensName: chain === "sepolia" ? "databot.agentrail.eth" : null,
  owner: "0xaa4d",
  agent: "0x6fb5",
  expiry: "1791542976",
  active: true,
  permissions: chain === "base" ? [{ id: "p", target: "0x3016", instructions: [], perTxLimit: "100", totalLimit: "500", spentTotal: "126", source: "onchain", targetChain: null }] : [],
  actions: chain === "base" ? [{ id: "0xtx:3", kind: "authorize", timestamp: "1788978000", target: "0x3016", amount: "42", allowed: true, blockReason: null, errorCode: null, txHash: "0xtx" }] : [],
});

/** A fake Studio that answers the fixed query for whichever chain the URL names. */
function fakeStudio() {
  const calls: { url: string; auth?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const chain = url.includes("base") ? "base" : "sepolia";
    return new Response(JSON.stringify({ data: { mandates: [studioMandate(chain)] } }), { status: 200 });
  });
  return { fetchImpl, calls };
}

describe("the shared-schema history on the server", () => {
  it("merges both Studio legs with the committed Solana snapshot and returns the feed shape", async () => {
    const { history } = await import("../lib/history");
    const { fetchImpl, calls } = fakeStudio();
    const snapshot = {
      syncedAt: "2026-09-10T14:01:11.356Z",
      endpoint: "devnet.sol.streamingfast.io:443",
      initialBlock: 495587900,
      nextBlock: 496178133,
      rowCount: 3,
      rows: [
        { entity: "Mandate", block: 1, data: { id: `${NODE}:solana`, ensNode: NODE, kind: "create_mandate", mandateId: `${NODE}:solana`, owner: "55FJ", agent: "4XwC", expiry: 1789061231, active: true } },
        { entity: "Action", block: 2, data: { id: "sigA:0", mandateId: `${NODE}:solana`, ensNode: NODE, kind: "execute_payment", target: SHOP, amount: 1500000, allowed: true, txHash: "sigA", timestamp: 1788976000 } },
        { entity: "Action", block: 3, data: { id: "sigB:0", mandateId: `${NODE}:solana`, ensNode: NODE, kind: "execute_payment", target: SHOP, amount: 2500000, allowed: false, blockReason: "OVER_BUDGET", errorCode: 6007, txHash: "sigB", timestamp: 1788976010 } },
      ],
    } as const;
    const out = await history(NODE, { fetch: fetchImpl as never, snapshot: snapshot as never });

    expect(calls.map((c) => c.url)).toEqual(["https://studio.test/sepolia", "https://studio.test/base"]);
    expect(calls[0].auth).toBe("Bearer test-key-not-real-1234567890");
    expect(out.sources.map((s) => s.chain)).toEqual(["sepolia", "base", "solana"]);
    expect(out.mandates).toHaveLength(3);
    // newest first, across chains
    expect(out.feed.map((r) => [r.chain, r.txHash])).toEqual([["base", "0xtx"], ["solana", "sigB"], ["solana", "sigA"]]);
    expect(out.summary).toEqual({ actions: 3, allowed: 2, blocked: 1, chains: 3, blockedByCode: { "6007": 1 } });
    expect(out.solana).toMatchObject({ syncedAt: "2026-09-10T14:01:11.356Z", endpoint: "devnet.sol.streamingfast.io:443", nextBlock: 496178133, rowCount: 3 });
    // an injected snapshot means no live tail was read; the payload says so instead of pretending
    expect(out.solana.tail).toMatchObject({ rows: 0, error: "live tail not read" });
  });

  it("serves the shape through the route handler and refuses a malformed node", async () => {
    const { GET } = await import("../app/api/history/route");
    const { fetchImpl } = fakeStudio();
    vi.stubGlobal("fetch", fetchImpl);
    const res = await GET(new Request(`http://x/api/history?ensNode=${NODE}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feed: unknown[]; summary: { blocked: number }; solana: { syncedAt: string } };
    expect(Array.isArray(body.feed)).toBe(true);
    expect(typeof body.solana.syncedAt).toBe("string");
    expect(body.summary.blocked).toBeGreaterThanOrEqual(1); // the committed snapshot carries the real refusals
    const bad = await GET(new Request("http://x/api/history?ensNode=nope"));
    expect(bad.status).toBe(400);
    vi.unstubAllGlobals();
  });

  it("ships the real snapshot: every Phase 5 refusal is a row, not a sample", () => {
    const snap = JSON.parse(fs.readFileSync(path.join(here, "../data/solana-activity.json"), "utf8")) as { rows: { entity: string; data: { allowed?: boolean; errorCode?: number } }[]; syncedAt: string };
    const refused = snap.rows.filter((r) => r.entity === "Action" && r.data.allowed !== true);
    expect(refused.length).toBeGreaterThanOrEqual(24);
    const codes = new Set(refused.map((r) => r.data.errorCode));
    for (const c of [6006, 6007, 6008, 6016, 3007]) expect(codes.has(c)).toBe(true);
    expect(Date.parse(snap.syncedAt)).toBeGreaterThan(0);
  });
});

describe("ENS classification (pure)", () => {
  it("tells an agent from a service from nothing, by records alone", () => {
    expect(classify("databot.agentrail.eth", { "rail.allowed": "[]", "rail.agent.solana": "4XwC" }).kind).toBe("agent");
    expect(classify("feed.agentrail.eth", { "rail.endpoint": "https://feed", "rail.chain": "hedera:testnet" }).kind).toBe("service");
    expect(classify("vitalik.eth", {}).kind).toBe("unknown");
  });

  it("normalises and validates names without touching a chain", () => {
    expect(normalizeName("  Databot.AgentRail.eth/ ")).toBe("databot.agentrail.eth");
    expect(looksLikeName("databot.agentrail.eth")).toBe(true);
    expect(looksLikeName("not a name")).toBe(false);
    expect(looksLikeName("0x68822ce9")).toBe(false);
  });

  it("finds the payee a demo endpoint bakes in, and nothing for a real one", () => {
    expect(payeeInEndpoint("https://agentrail-data-feed.onrender.com/demo/unlisted/price/SOL,HBAR?payTo=0.0.98")).toBe("0.0.98");
    expect(payeeInEndpoint("https://agentrail-data-feed.onrender.com")).toBeNull();
  });
});

describe("explorer links and error codes", () => {
  it("builds a link for every chain, including Hedera's transaction id form", () => {
    expect(CHAINS.solana.tx("5TV8")).toBe("https://explorer.solana.com/tx/5TV8?cluster=devnet");
    expect(CHAINS.base.tx("0xab")).toBe("https://sepolia.basescan.org/tx/0xab");
    expect(CHAINS.sepolia.address("0xcd")).toBe("https://sepolia.etherscan.io/address/0xcd");
    expect(CHAINS.hedera.tx("0.0.7162784@1789035240.310880451")).toBe("https://hashscan.io/testnet/transaction/0.0.7162784-1789035240-310880451");
    expect(chainFromCaip("eip155:84532")).toBe("base");
    expect(chainFromCaip("cosmos:hub")).toBeNull();
  });

  it("names every code the demo produces", () => {
    expect(errorName(6006)).toBe("InstructionNotAllowed");
    expect(errorName(6016)).toBe("DestinationNotAllowed");
    expect(errorName(3007)).toBe("AccountOwnedByWrongProgram");
    expect(errorReason(6007)).toMatch(/per-transaction/);
    expect(errorName(null)).toBeNull();
    // a code below 6000 is the token program's, reached through execute_payment's CPI
    expect(errorName(4)).toBe("OwnerMismatch (SPL Token 4)");
    expect(errorReason(4)).toMatch(/not this account.s delegate/);
    expect(errorName(99)).toBe("error 99");
  });
});

describe("formatting", () => {
  it("keeps units on amounts and truncates the middle of long values", () => {
    expect(usdc("1500000")).toBe("1.5 USDC");
    expect(usdc("18446744073709551615")).toMatch(/USDC$/);
    expect(amountFor("solana", "2500000")).toBe("2.5 USDC");
    expect(amountFor("base", "42")).toBe("0.000042 USDC");
    expect(amountFor("hedera", "30000")).toBe("0.03 USDC");
    expect(amountFor("sepolia", "7")).toBe("7");
    expect(truncate("5TV8UjnJvJGuydMwqikHXchTkvpSJggfnR6Ld9T5bNy2qriCNzvSTjh8qDYXgcAZKLiBPPT9zNbubHSrpVd2iYF1")).toBe("5TV8Uj…iYF1");
    expect(headroom("4500000", "5000000")).toBeCloseTo(0.1, 5);
    expect(headroom("1", "0")).toBeNull();
    expect(untilExpiry(1000, 2000).expired).toBe(true);
    expect(untilExpiry(2000 + 7200, 2000).text).toBe("expires in 2 h 0 min");
  });
});

describe("secret isolation", () => {
  it("exposes nothing secret-shaped through the public config, and no NEXT_PUBLIC_ variable carries a key", () => {
    // PUBLIC is the only config a component may read; it must not be able to carry a credential.
    const src = fs.readFileSync(path.join(here, "../lib/env.ts"), "utf8");
    const publicBlock = src.slice(src.indexOf("export const PUBLIC"));
    expect(publicBlock).not.toMatch(/GRAPH_API_KEY|PRIVATE_KEY|DEPLOY_KEY|SUBSTREAMS_API_TOKEN|GEMINI|GROQ/);
    const example = fs.readFileSync(path.join(here, "../../.env.example"), "utf8");
    expect(example).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|PRIVATE|TOKEN)/);
    // components never import the server env accessor
    const componentFiles = fs.readdirSync(path.join(here, "../components/ui"));
    for (const f of componentFiles) expect(fs.readFileSync(path.join(here, "../components/ui", f), "utf8")).not.toMatch(/serverEnv|process\.env/);
  });
});
