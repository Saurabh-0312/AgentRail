import { buildSchema, graphql } from "graphql";
import { describe, expect, it, vi } from "vitest";

import { HISTORY_QUERY, fetchHistory, foldSolana, type Mandate } from "../src/history.ts";
import { SDL, createServer } from "../src/server.ts";
import type { SolanaRow } from "../src/solana-sink.ts";

const NODE = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const SHOP = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";
const MID = `${NODE}:solana`;

/** What the sink stores: the live jsonl rows of the 2026-09-09 demo run, abbreviated. */
const solanaRows: SolanaRow[] = [
  { entity: "Mandate", block: 495753245, data: { id: MID, ensNode: NODE, kind: "revoke_mandate", pda: PDA, mandateId: MID } },
  { entity: "Mandate", block: 495753253, data: { id: MID, ensNode: NODE, kind: "create_mandate", pda: PDA, owner: "55FJ", agent: "4XwC", expiry: 1789061231, active: true } },
  { entity: "Permission", block: 495753258, data: { id: `${MID}:${SHOP}`, mandateId: MID, ensNode: NODE, target: SHOP, perTxLimit: 2000000, totalLimit: 5000000, kind: "add_permission" } },
  { entity: "Action", block: 495753288, data: { id: "5G6A:0", mandateId: MID, ensNode: NODE, kind: "execute_payment", target: SHOP, amount: 1500000, allowed: true, txHash: "5G6A", timestamp: 1788976000 } },
  { entity: "Action", block: 495753299, data: { id: "26Mb:0", mandateId: MID, ensNode: NODE, kind: "execute_payment", target: SHOP, amount: 2500000, allowed: false, blockReason: "OVER_BUDGET", errorCode: 6007, txHash: "26Mb", timestamp: 1788976010 } },
  { entity: "Action", block: 495753444, data: { id: "2448:0", mandateId: MID, ensNode: NODE, kind: "verify", target: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", allowed: false, blockReason: "NOT_PERMITTED", errorCode: 6006, txHash: "2448", timestamp: 1788976100 } },
  { entity: "Action", block: 495753460, data: { id: "other:0", mandateId: "0xabc:solana", ensNode: "0xabc", kind: "execute_payment", target: SHOP, amount: 1, allowed: true, txHash: "other", timestamp: 1 } },
];

const studioMandate = (chain: string): Mandate => ({
  id: `${NODE}:${chain}`,
  chain,
  ensNode: NODE,
  ensName: chain === "sepolia" ? "databot.agentrail.eth" : null,
  owner: "0xaa4d",
  agent: "0x6fb5",
  expiry: "1791542976",
  active: true,
  permissions: [],
  actions: chain === "base" ? [{ id: "0xtx:3", kind: "authorize", timestamp: "1788978000", target: "0x3016", amount: "42", allowed: true, blockReason: null, errorCode: null, txHash: "0xtx" }] : [],
});

/** A fake Studio: answers the fixed query for whichever chain the URL names. */
function fakeStudio() {
  const calls: { url: string; body: any; auth?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    calls.push({ url, body, auth: init?.headers?.Authorization });
    if (url.includes("down")) return new Response(JSON.stringify({ errors: [{ message: "indexer offline" }] }), { status: 200 });
    const chain = url.includes("base") ? "base" : "sepolia";
    return new Response(JSON.stringify({ data: { mandates: [studioMandate(chain)] } }), { status: 200 });
  });
  return { fetchImpl, calls };
}

describe("foldSolana", () => {
  it("folds the sink rows into one Mandate with permissions, actions and the refusals intact", () => {
    const [m] = foldSolana(solanaRows, NODE);
    expect(m.id).toBe(MID);
    expect(m.chain).toBe("solana");
    expect(m.active).toBe(true);
    expect(m.owner).toBe("55FJ");
    expect(m.permissions).toHaveLength(1);
    expect(m.permissions[0]).toMatchObject({ target: SHOP, perTxLimit: "2000000", totalLimit: "5000000", spentTotal: "1500000", source: "onchain" });
    expect(m.actions.map((a) => [a.kind, a.allowed, a.blockReason, a.errorCode])).toEqual([
      ["execute_payment", true, null, null],
      ["execute_payment", false, "OVER_BUDGET", 6007],
      ["verify", false, "NOT_PERMITTED", 6006],
    ]);
  });

  it("filters by ensNode case-insensitively and ignores other mandates", () => {
    expect(foldSolana(solanaRows, NODE.toUpperCase())).toHaveLength(1);
    expect(foldSolana(solanaRows, "0xabc")[0].actions).toHaveLength(1);
    expect(foldSolana(solanaRows, "0xdead")).toHaveLength(0);
  });
});

describe("fetchHistory: the same query on every source", () => {
  it("sends HISTORY_QUERY verbatim to both Studio endpoints with the API key and concatenates the rows", async () => {
    const studio = fakeStudio();
    const r = await fetchHistory(NODE, { sepoliaUrl: "https://studio/sepolia", baseUrl: "https://studio/base", apiKey: "k", solanaRows: () => solanaRows, fetch: studio.fetchImpl });
    expect(studio.calls.map((c) => c.url)).toEqual(["https://studio/sepolia", "https://studio/base"]);
    for (const c of studio.calls) {
      expect(c.body.query).toBe(HISTORY_QUERY);
      expect(c.body.variables).toEqual({ ensNode: NODE });
      expect(c.auth).toBe("Bearer k");
    }
    expect(r.mandates.map((m) => m.chain)).toEqual(["sepolia", "base", "solana"]);
    expect(r.mandates.every((m) => m.ensNode.toLowerCase() === NODE)).toBe(true);
    const blocked = r.mandates.flatMap((m) => m.actions).filter((a) => !a.allowed);
    expect(blocked.map((a) => a.errorCode)).toEqual([6007, 6006]);
    expect(r.sources.map((s) => [s.chain, s.mandates, s.actions])).toEqual([["sepolia", 1, 0], ["base", 1, 1], ["solana", 1, 3]]);
  });

  it("a source that is down is reported, not fatal: the other chains still answer", async () => {
    const studio = fakeStudio();
    const r = await fetchHistory(NODE, { sepoliaUrl: "https://studio/down", baseUrl: "https://studio/base", apiKey: "k", solanaRows: () => solanaRows, fetch: studio.fetchImpl });
    expect(r.mandates.map((m) => m.chain)).toEqual(["base", "solana"]);
    expect(r.sources[0].error).toContain("indexer offline");
  });
});

describe("the GraphQL endpoint over the shared schema", () => {
  it("parses the shared schema verbatim plus the root query", () => {
    const schema = buildSchema(SDL);
    for (const t of ["Mandate", "Permission", "Action", "Agent", "Service"]) expect(schema.getType(t)).toBeTruthy();
    expect(schema.getQueryType()?.getFields().mandates).toBeTruthy();
  });

  it("one query, one ensNode, rows from three chains", async () => {
    const studio = fakeStudio();
    const app = createServer({ sepoliaUrl: "https://studio/sepolia", baseUrl: "https://studio/base", apiKey: "k", solanaRows: () => solanaRows, fetch: studio.fetchImpl });
    const res = await app.request("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{ mandates(where: { ensNode: "${NODE}" }) { chain actions { allowed blockReason amount } } }` }),
    });
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.mandates.map((m: any) => m.chain)).toEqual(["sepolia", "base", "solana"]);
    const solana = body.data.mandates[2];
    expect(solana.actions.filter((a: any) => !a.allowed).map((a: any) => a.blockReason)).toEqual(["OVER_BUDGET", "NOT_PERMITTED"]);
    // the filter by chain is honoured and the join key is mandatory
    const one = await (await app.request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `{ mandates(where: { ensNode: "${NODE}", chain: "base" }) { chain } }` }) })).json();
    expect(one.data.mandates).toEqual([{ chain: "base" }]);
    const bad = await (await app.request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `{ mandates(where: { chain: "base" }) { chain } }` }) })).json();
    expect(bad.errors[0].message).toContain("ensNode");
    // graphql-js answers directly too
    const direct = await graphql({ schema: buildSchema(SDL), source: "{ sources(ensNode: \"0x00\") { chain } }", rootValue: { sources: async () => [] } });
    expect(direct.errors).toBeUndefined();
  });
});
