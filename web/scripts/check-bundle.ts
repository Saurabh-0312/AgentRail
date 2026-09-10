/**
 * After `next build`, prove no secret reached the client bundle. Every file under `.next/static`
 * is what browsers download; none of it may contain the value of a key or a private key, and the
 * server-only variable names should not appear there either.
 *
 *   yarn workspace @agentrail/web build && yarn workspace @agentrail/web check:bundle
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(here, "../.next/static");
const ROOT_ENV = path.resolve(here, "../../.env");

// Values: anything that looks like a credential in the root .env (never printed).
const secrets: { name: string; value: string }[] = [];
if (fs.existsSync(ROOT_ENV)) {
  for (const line of fs.readFileSync(ROOT_ENV, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const [, name, value] = m;
    if (/KEY|SECRET|PRIVATE|TOKEN|PASSWORD/i.test(name) && value.length >= 12) secrets.push({ name, value: value.replace(/^"(.*)"$/, "$1") });
  }
}
const serverOnlyNames = ["GRAPH_API_KEY", "SUBGRAPH_STUDIO_DEPLOY_KEY", "DEPLOYER_PRIVATE_KEY", "AGENT_EVM_PRIVATE_KEY", "HEDERA_PRIVATE_KEY", "SEPOLIA_PRIVATE_KEY", "BASE_SEPOLIA_PRIVATE_KEY", "GEMINI_API_KEY", "GROQ_API_KEY"];

if (!fs.existsSync(STATIC)) {
  console.error(`no client bundle at ${STATIC}; run \`next build\` first`);
  process.exit(1);
}

const files: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(STATIC);

const hits: string[] = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  for (const s of secrets) if (text.includes(s.value)) hits.push(`${path.relative(STATIC, f)}: contains the value of ${s.name}`);
  for (const n of serverOnlyNames) if (text.includes(n)) hits.push(`${path.relative(STATIC, f)}: mentions ${n}`);
}

console.log(`scanned ${files.length} client files for ${secrets.length} secret value(s) and ${serverOnlyNames.length} server-only name(s)`);
if (hits.length) {
  console.error("SECRET LEAK:\n  " + hits.join("\n  "));
  process.exit(1);
}
console.log("client bundle is clean: no secret value and no server-only variable name appears in .next/static");
