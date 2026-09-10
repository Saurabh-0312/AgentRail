/**
 * The Solana leg of the shared schema. Streams `map_activity` from the AgentRail Substreams package
 * through a Graph provider (StreamingFast's devnet endpoint, Graph Market token) and keeps the rows
 * in a local JSONL file with a resume point, so the reader can answer without re-streaming history.
 *
 * The provider is the data source; this file is a cache of it. Delete `out/` to rebuild from the
 * package's initial block.
 *
 *   SUBSTREAMS_ENDPOINT   devnet.sol.streamingfast.io:443 (default)
 *   SUBSTREAMS_API_TOKEN  from `substreams auth` (.substreams.env)
 *   SOLANA_RPC_URL        to learn the current slot (the stop block)
 *
 * Run: yarn workspace @agentrail/query sink [--to <slot>]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SUBSTREAMS_DIR = path.resolve(here, "../../substreams");
export const OUT_DIR = path.resolve(here, "../out");
export const ROWS_FILE = path.join(OUT_DIR, "solana-activity.jsonl");
const CURSOR_FILE = path.join(OUT_DIR, "cursor.json");
const PACKAGE = path.join(SUBSTREAMS_DIR, "agentrail-mandates-v0.1.0.spkg");
export const INITIAL_BLOCK = 495587900; // just before the first Phase 1 transaction (slot 495587905)

export interface SolanaRow {
  entity: "Mandate" | "Permission" | "Action";
  block: number;
  data: Record<string, unknown>;
}

function readToken(): string {
  if (process.env.SUBSTREAMS_API_TOKEN) return process.env.SUBSTREAMS_API_TOKEN;
  const envFile = path.resolve(here, "../../../.substreams.env");
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/SUBSTREAMS_API_TOKEN=(\S+)/);
    if (m) return m[1].replace(/^"|"$/g, "");
  }
  throw new Error("SUBSTREAMS_API_TOKEN missing: run `substreams auth`");
}

/** The public devnet RPC rate-limits freely; retry with backoff before giving up. */
async function currentSlot(attempts = 6): Promise<number> {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] }) });
      const d = (await r.json().catch(() => ({}))) as { result?: number };
      if (typeof d.result === "number") return d.result;
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = String(e);
    }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw new Error(`getSlot failed after ${attempts} attempts: ${lastError}`);
}

/** Blocks per `substreams run`; each chunk advances the cursor, so a dropped stream loses one chunk. */
export const CHUNK = 40_000;

export function readCursor(): number {
  try {
    return (JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")) as { next: number }).next;
  } catch {
    return INITIAL_BLOCK;
  }
}

/** Every row streamed so far. */
export function readRows(): SolanaRow[] {
  if (!fs.existsSync(ROWS_FILE)) return [];
  return fs
    .readFileSync(ROWS_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SolanaRow);
}

/** Stream [from, to] through the provider and append the rows. Returns how many rows arrived. */
export async function sync(from: number, to: number, endpoint = process.env.SUBSTREAMS_ENDPOINT ?? "devnet.sol.streamingfast.io:443"): Promise<number> {
  if (to < from) return 0;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = ["run", "-e", endpoint, PACKAGE, "map_activity", "-s", String(from), "-t", String(to + 1), "--output", "jsonl", "--limit-processed-blocks", "0"];
  const child = spawn("substreams", args, { env: { ...process.env, SUBSTREAMS_API_TOKEN: readToken() }, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  let rows = 0;
  let stderr = "";
  const out = fs.createWriteStream(ROWS_FILE, { flags: "a" });
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(code) : reject(new Error(`substreams exited ${code}: ${stderr.slice(-800)}`))));
  });
  for await (const chunk of child.stdout) {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let msg: { "@block"?: number; "@data"?: Record<string, unknown[]> };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const block = msg["@block"] ?? 0;
      const data = msg["@data"] ?? {};
      for (const [key, entity] of [["mandates", "Mandate"], ["permissions", "Permission"], ["actions", "Action"]] as const) {
        for (const item of (data[key] ?? []) as Record<string, unknown>[]) {
          out.write(JSON.stringify({ entity, block, data: item } satisfies SolanaRow) + "\n");
          rows++;
        }
      }
    }
  }
  await done;
  out.end();
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ next: to + 1, syncedAt: new Date().toISOString(), endpoint }));
  return rows;
}

if (process.argv[1] && process.argv[1].endsWith("solana-sink.ts")) {
  const toArg = process.argv.indexOf("--to");
  const from = readCursor();
  const to = toArg > 0 ? Number(process.argv[toArg + 1]) : await currentSlot();
  console.log(`solana sink: streaming map_activity ${from} -> ${to} (${Math.max(0, to - from + 1)} blocks) from the provider in chunks of ${CHUNK}`);
  let rows = 0;
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, to);
    const got = await sync(start, end);
    rows += got;
    console.log(`  ${start} -> ${end}: +${got} rows`);
  }
  const all = readRows();
  const refused = all.filter((r) => r.entity === "Action" && r.data.allowed !== true).length;
  console.log(`+${rows} rows; ${all.length} rows total, ${refused} refused actions. next block ${to + 1}. ${ROWS_FILE}`);
}
