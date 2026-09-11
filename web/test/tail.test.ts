import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import idl from "@agentrail/sdk/src/solana/agentrail.idl.json";
import { foldSolana } from "@agentrail/query/src/history.ts";
import type { SolanaRow } from "@agentrail/query/src/solana-sink.ts";

import { ActivityFeed, mergeFeed } from "../components/activity-feed";
import { toFeed, type FeedRow } from "../lib/history";
import { AGENTRAIL_PROGRAM, blockReason, decodeTail, ensNodeFromAccount, errorNumberFromLogs, fetchTail, mergeRows, parseErr, pdaIndex, type TailTx } from "../lib/solana-tail";

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const AGENT = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const OWNER = "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb";
const SHOP_ATA = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSVAR = "Sysvar1nstructions1111111111111111111111111";

const disc = (name: string) => Uint8Array.from((idl as { instructions: { name: string; discriminator: number[] }[] }).instructions.find((i) => i.name === name)!.discriminator);
const u64 = (n: bigint) => { const out = new Uint8Array(8); for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn); return out; };
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

/** One execute_payment transaction: keys [pda, agent, from, destination, token program, program]. */
function payment(signature: string, slot: number, amount: bigint, err: unknown, logs: string[] = []): TailTx {
  return {
    signature, slot, blockTime: 1_789_200_000 + slot, err, logMessages: logs,
    accountKeys: [PDA, AGENT, "AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9", SHOP_ATA, SPL, AGENTRAIL_PROGRAM],
    instructions: [{ programIdIndex: 5, accounts: [0, 1, 2, 3, 4], data: cat(disc("execute_payment"), u64(amount)) }],
  };
}

/** verify at index 0 about the SPL Token instruction at index 1. */
function verified(signature: string, slot: number, splTag: number, err: unknown): TailTx {
  return {
    signature, slot, blockTime: 1_789_200_000 + slot, err, logMessages: [],
    accountKeys: [PDA, AGENT, SYSVAR, "AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9", OWNER, SPL, AGENTRAIL_PROGRAM],
    instructions: [
      { programIdIndex: 6, accounts: [0, 1, 2], data: cat(disc("verify"), Uint8Array.of(1), u64(500_000n)) },
      { programIdIndex: 5, accounts: [3, 4], data: cat(Uint8Array.of(splTag), u64(500_000n)) },
    ],
  };
}

const err = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] });
const nodeOf = (pda: string) => (pda === PDA ? NODE : null);

describe("the tail keeps failed transactions and grades them like the Substreams module", () => {
  it("a refused payment is a row with allowed: false and the reason of its code", () => {
    const rows = decodeTail([payment("sigA", 500_000_001, 2_500_000n, err(0, 6007)), payment("sigB", 500_000_002, 1_000_000n, err(0, 6008)), payment("sigC", 500_000_003, 1_000_000n, err(0, 6016))], nodeOf);
    expect(rows).toHaveLength(3);
    expect(rows[0].data).toMatchObject({ kind: "execute_payment", blockReason: "OVER_BUDGET", errorCode: 6007, errorName: "PerTxLimitExceeded", amount: "2500000", target: SHOP_ATA, ensNode: NODE, mandateId: `${NODE}:solana` });
    expect(rows[0].data.allowed).toBeUndefined();
    expect(rows[1].data).toMatchObject({ blockReason: "OVER_BUDGET", errorCode: 6008 });
    expect(rows[2].data).toMatchObject({ blockReason: "NOT_PERMITTED", errorCode: 6016, errorName: "DestinationNotAllowed" });
  });

  it("a landed payment is allowed, with no reason and no code", () => {
    const [row] = decodeTail([payment("sigOk", 500_000_010, 1_000_000n, null)], nodeOf);
    expect(row.data).toMatchObject({ allowed: true, amount: "1000000", txHash: "sigOk", id: "sigOk:0", slot: "500000010" });
    expect(row.data.blockReason).toBeUndefined();
    expect(row.data.errorCode).toBeUndefined();
  });

  it("verify reports the sibling program it was asked about, refused 6006 for SetAuthority, allowed for Transfer", () => {
    const rows = decodeTail([verified("sigSeize", 500_000_020, 6, err(0, 6006)), verified("sigMove", 500_000_021, 3, null)], nodeOf);
    expect(rows[0].data).toMatchObject({ kind: "verify", target: SPL, blockReason: "NOT_PERMITTED", errorCode: 6006, errorName: "InstructionNotAllowed" });
    expect(rows[1].data).toMatchObject({ kind: "verify", target: SPL, allowed: true, amount: "500000" });
  });

  it("a failure in another instruction is FAILED, not the mandate's verdict; the log is the fallback for the code", () => {
    const [other] = decodeTail([verified("sigOther", 500_000_030, 3, err(1, 1))], nodeOf);
    expect(other.data).toMatchObject({ blockReason: "FAILED" });
    expect(other.data.errorCode).toBeUndefined();
    const [fromLog] = decodeTail([payment("sigLog", 500_000_031, 1n, { InstructionError: [0, "ProgramFailedToComplete"] }, ["Program log: AnchorError thrown. Error Number: 6001. Error Message: expired"])], nodeOf);
    expect(fromLog.data).toMatchObject({ blockReason: "EXPIRED", errorCode: 6001, errorName: "Expired" });
    expect(blockReason(6000)).toBe("REVOKED");
    expect(blockReason(6005)).toBe("NOT_PERMITTED");
    expect(blockReason(1)).toBe("FAILED");
    expect(parseErr(null)).toBeNull();
    expect(parseErr("InsufficientFundsForFee")).toEqual({ instructionIndex: null, customCode: null });
    expect(errorNumberFromLogs(["x", "Error Number: 6016."])).toBe(6016);
  });

  it("learns the join key from a create_mandate inside the window, so a later revoke still joins", () => {
    const node = "0x" + "ab".repeat(32);
    const nodeBytes = Uint8Array.from(Buffer.from(node.slice(2), "hex"));
    const freshPda = "BYexGeRedsCFR4obHPsbhuv8Ykxavk23pjBSqedtaiAa";
    const create: TailTx = { signature: "sigCreate", slot: 600_000_001, blockTime: 1, err: null, logMessages: [], accountKeys: [freshPda, OWNER, AGENT, "11111111111111111111111111111111", AGENTRAIL_PROGRAM], instructions: [{ programIdIndex: 4, accounts: [0, 1, 2, 3], data: cat(disc("create_mandate"), nodeBytes, u64(1_800_000_000n)) }] };
    const revoke: TailTx = { signature: "sigRevoke", slot: 600_000_002, blockTime: 2, err: null, logMessages: [], accountKeys: [freshPda, OWNER, AGENTRAIL_PROGRAM], instructions: [{ programIdIndex: 2, accounts: [0, 1], data: disc("revoke_mandate") }] };
    const rows = decodeTail([revoke, create], () => null);
    expect(rows.map((r) => r.data.kind)).toEqual(["create_mandate", "revoke_mandate"]);
    expect(rows[0].data).toMatchObject({ ensNode: node, id: `${node}:solana`, pda: freshPda, owner: OWNER, agent: AGENT, active: true, expiry: "1800000000" });
    expect(rows[1].data).toMatchObject({ ensNode: node, id: `${node}:solana` });
  });

  it("reads ens_node from a mandate account's bytes and the snapshot's PDA index", () => {
    const bytes = new Uint8Array(200);
    bytes.set(Buffer.from(NODE.slice(2), "hex"), 80);
    expect(ensNodeFromAccount(bytes)).toBe(NODE);
    expect(ensNodeFromAccount(new Uint8Array(10))).toBeNull();
    const snap = JSON.parse(fs.readFileSync(path.join(here, "../data/solana-activity.json"), "utf8")) as { rows: SolanaRow[] };
    expect(pdaIndex(snap.rows).get(PDA)).toBe(NODE);
  });
});

describe("the decoded row shape matches the snapshot's exactly", () => {
  it("an Action row carries the same keys, in the same types, as a snapshot Action row", () => {
    const snap = JSON.parse(fs.readFileSync(path.join(here, "../data/solana-activity.json"), "utf8")) as { rows: SolanaRow[] };
    const refused = snap.rows.find((r) => r.entity === "Action" && r.data.allowed !== true && r.data.kind === "execute_payment")!;
    const landed = snap.rows.find((r) => r.entity === "Action" && r.data.allowed === true && r.data.kind === "execute_payment")!;
    const [tailRefused] = decodeTail([payment("sigA", 500_000_001, 2_500_000n, err(0, 6007))], nodeOf);
    const [tailLanded] = decodeTail([payment("sigOk", 500_000_010, 1_000_000n, null)], nodeOf);
    const keys = (r: SolanaRow) => Object.keys(r.data).sort();
    expect(keys(tailRefused)).toEqual(keys(refused));
    expect(keys(tailLanded)).toEqual(keys(landed));
    for (const k of keys(refused)) expect(typeof tailRefused.data[k], k).toBe(typeof refused.data[k]);
    expect(Object.keys(tailRefused).sort()).toEqual(["block", "data", "entity"]);
  });
});

describe("merging the tail over the snapshot", () => {
  it("de-duplicates by signature and keeps block order for the fold", () => {
    const snap = JSON.parse(fs.readFileSync(path.join(here, "../data/solana-activity.json"), "utf8")) as { rows: SolanaRow[]; nextBlock: number };
    const dup = snap.rows.find((r) => r.entity === "Action")!;
    const fresh = decodeTail([payment("sigNew", snap.nextBlock + 5, 1_000_000n, err(0, 6006))], nodeOf);
    const merged = mergeRows(snap.rows, [dup, ...fresh]);
    expect(merged).toHaveLength(snap.rows.length + 1);
    expect(merged[merged.length - 1].data.txHash).toBe("sigNew");
    for (let i = 1; i < merged.length; i++) expect(merged[i].block).toBeGreaterThanOrEqual(merged[i - 1].block);
    // the fold sees the new refusal under the same name as the history
    const feed = toFeed(foldSolana(merged, NODE));
    expect(feed[0]).toMatchObject({ txHash: "sigNew", allowed: false, errorCode: 6006 });
    expect(feed.filter((r) => !r.allowed).length).toBeGreaterThanOrEqual(25);
  });

  it("the feed merges refreshed rows by id, newest first, and reports what is new", () => {
    const base: FeedRow[] = [{ id: "a:0", timestamp: "10", target: "t", amount: "1", allowed: true, blockReason: null, errorCode: null, txHash: "a", kind: "execute_payment", chain: "solana", mandateId: "m" }];
    const incoming: FeedRow[] = [{ ...base[0] }, { ...base[0], id: "b:0", txHash: "b", timestamp: "20", allowed: false, blockReason: "NOT_PERMITTED", errorCode: 6006 }];
    const { rows, added } = mergeFeed(base, incoming);
    expect(rows.map((r) => r.id)).toEqual(["b:0", "a:0"]);
    expect(added).toEqual(["b:0"]);
  });
});

describe("when the RPC is down", () => {
  it("fetchTail degrades to an empty tail with the error, never an exception", async () => {
    const connection = { getSlot: vi.fn(async () => { throw new Error("429 Too Many Requests"); }), getSignaturesForAddress: vi.fn(), getTransaction: vi.fn(), getAccountInfo: vi.fn() };
    const out = await fetchTail(connection as never, { sinceSlot: 496178133, ensNodeOfPda: () => null, retries: 3, retryBaseMs: 5 });
    expect(out.rows).toEqual([]);
    expect(out.error).toMatch(/429/);
    expect(out.fromSlot).toBe(496178133);
    expect(connection.getSlot).toHaveBeenCalledTimes(3); // retried with backoff, then gave up
  });

  it("the history keeps the snapshot rows and the page says the tail is unavailable", async () => {
    vi.stubEnv("GRAPH_API_KEY", "test-key-not-real-1234567890");
    vi.stubEnv("SUBGRAPH_SEPOLIA_URL", "https://studio.test/sepolia");
    vi.stubEnv("SUBGRAPH_BASE_URL", "https://studio.test/base");
    const { history } = await import("../lib/history");
    const snap = JSON.parse(fs.readFileSync(path.join(here, "../data/solana-activity.json"), "utf8"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { mandates: [] } }), { status: 200 }));
    const out = await history(NODE, { fetch: fetchImpl as never, snapshot: snap, tail: { fromSlot: snap.nextBlock, throughSlot: snap.nextBlock, fetchedAt: "2026-09-12T00:00:00Z", signatures: 0, rows: [], error: "fetch failed" } });
    expect(out.summary.blocked).toBeGreaterThanOrEqual(24);
    expect(out.solana.tail.error).toBe("fetch failed");
    const html = renderToStaticMarkup(createElement(ActivityFeed, { rows: out.feed, live: { ensNode: NODE, historySyncedAt: out.solana.syncedAt, historyThroughSlot: out.solana.nextBlock - 1, tail: out.solana.tail } }));
    expect(html).toContain("live tail unavailable, showing history to slot 496178132");
    expect(html).toContain("history synced 2026-09-10 14:01");
    expect((html.match(/data-verdict="blocked"/g) ?? []).length).toBeGreaterThanOrEqual(24);
    expect(html).toContain('data-testid="refresh"');
  });

  it("with a live tail both timestamps are shown", () => {
    const html = renderToStaticMarkup(createElement(ActivityFeed, { rows: [], live: { ensNode: NODE, historySyncedAt: "2026-09-10T14:01:11.356Z", historyThroughSlot: 496178132, tail: { throughSlot: 497000000, fetchedAt: new Date().toISOString(), error: null } } }));
    expect(html).toContain("to slot 496178132");
    expect(html).toContain("live through slot 497000000");
  });
});

describe("the cache in front of the RPC", () => {
  it("serves a good read, extends it incrementally with only newer signatures, and keeps it when a refresh fails", async () => {
    const { cachedTail } = await import("../lib/solana-tail");
    const sigs = [{ signature: "sigB", slot: 500_000_002, err: null }, { signature: "sigA", slot: 500_000_001, err: null }];
    let newer: typeof sigs = [];
    let fail = false;
    const connection = {
      getSlot: vi.fn(async () => {
        if (fail) throw new Error("429 Too Many Requests");
        return 500_000_100;
      }),
      getSignaturesForAddress: vi.fn(async (_p: unknown, o: { until?: string }) => (o.until ? newer : sigs)),
      getTransaction: vi.fn(async () => null),
      getAccountInfo: vi.fn(),
    };
    const read = cachedTail(60_000, 10_000);
    const opts = { sinceSlot: 500_000_000, ensNodeOfPda: () => null, retries: 1, retryBaseMs: 1, pauseMs: 0 };
    const first = await read(connection as never, opts);
    expect(first.signatures).toBe(2);
    expect(first.newestSignature).toBe("sigB");
    // within the ttl nothing is re-read
    await read(connection as never, opts);
    expect(connection.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    // a forced refresh asks only for what came after sigB
    newer = [{ signature: "sigC", slot: 500_000_050, err: null }];
    const second = await read(connection as never, opts, true);
    expect(connection.getSignaturesForAddress).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ until: "sigB" }), "confirmed");
    expect(second.signatures).toBe(3);
    expect(second.newestSignature).toBe("sigC");
    // an RPC failure on the next refresh keeps the last good read, marked stale, with the error
    fail = true;
    const third = await read(connection as never, opts, true);
    expect(third.stale).toBe(true);
    expect(third.error).toMatch(/429/);
    expect(third.signatures).toBe(3);
    // and is not retried for a while
    await read(connection as never, opts, true);
    expect(connection.getSlot).toHaveBeenCalledTimes(3);
  });
});

describe("secret isolation", () => {
  beforeAll(() => vi.unstubAllEnvs());
  it("the tail library and the feed never read the environment", () => {
    for (const f of ["../lib/solana-tail.ts", "../components/activity-feed.tsx"]) expect(fs.readFileSync(path.join(here, f), "utf8")).not.toMatch(/process\.env|serverEnv|API_KEY|PRIVATE_KEY/);
  });
});
