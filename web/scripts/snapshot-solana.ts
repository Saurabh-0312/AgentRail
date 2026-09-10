/**
 * Turn the reader's local Solana sink (indexer/query/out, gitignored) into the snapshot the site
 * serves (web/data/solana-activity.json, committed as product data). Run `yarn sink:solana` first
 * so the sink is current, then:
 *
 *   yarn workspace @agentrail/web snapshot:solana
 *
 * The snapshot records when it was taken; the UI shows that timestamp rather than implying the
 * Solana leg is live.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../indexer/query/out");
const ROWS = path.join(OUT, "solana-activity.jsonl");
const CURSOR = path.join(OUT, "cursor.json");
const TARGET = path.resolve(here, "../data/solana-activity.json");
const INITIAL_BLOCK = 495587900;

if (!fs.existsSync(ROWS)) {
  console.error(`no sink at ${ROWS}; run \`yarn sink:solana\` at the repo root first`);
  process.exit(1);
}
const rows = fs.readFileSync(ROWS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
const cursor = fs.existsSync(CURSOR) ? (JSON.parse(fs.readFileSync(CURSOR, "utf8")) as { next: number; syncedAt: string; endpoint: string }) : { next: INITIAL_BLOCK, syncedAt: new Date().toISOString(), endpoint: "devnet.sol.streamingfast.io:443" };
const snapshot = { syncedAt: cursor.syncedAt, endpoint: cursor.endpoint, initialBlock: INITIAL_BLOCK, nextBlock: cursor.next, rowCount: rows.length, rows };
fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, JSON.stringify(snapshot, null, 1) + "\n");
const refused = rows.filter((r) => (r as { entity: string; data: { allowed?: boolean } }).entity === "Action" && (r as { data: { allowed?: boolean } }).data.allowed !== true).length;
console.log(`wrote ${path.relative(process.cwd(), TARGET)}: ${rows.length} rows (${refused} refused actions), synced ${cursor.syncedAt}, next block ${cursor.next}`);
