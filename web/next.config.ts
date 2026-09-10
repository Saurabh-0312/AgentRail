import * as fs from "node:fs";
import * as path from "node:path";
import type { NextConfig } from "next";

/**
 * Local development reads the repo's root `.env` so there is one source of truth for RPC URLs and
 * the Graph API key; on Vercel the same names are set in the project's environment. Only variables
 * that are not already set are filled in, and nothing here is ever prefixed NEXT_PUBLIC_, so none
 * of it can reach the client bundle.
 */
function loadRootEnv() {
  const file = path.resolve(process.cwd(), "../.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^"(.*)"$/, "$1");
  }
}
loadRootEnv();

const nextConfig: NextConfig = {
  // The workspace packages are shipped as TypeScript sources; Next compiles them like app code.
  transpilePackages: ["@agentrail/query", "@agentrail/sdk"],
  // Chain SDKs stay as ordinary Node requires on the server instead of being bundled.
  serverExternalPackages: ["@coral-xyz/anchor", "@solana/web3.js", "@solana/spl-token", "@x402/hedera", "@x402/evm", "@hiero-ledger/sdk", "viem"],
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
