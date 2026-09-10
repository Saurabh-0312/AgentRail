/**
 * Server-side configuration. Nothing in this module is prefixed NEXT_PUBLIC_, so nothing here can
 * be inlined into the client bundle; route handlers import it, components never do. The public
 * addresses are the deployed artifacts from SPEC §8A and are safe to show; the API key and RPC
 * URLs stay on the server.
 */
import "server-only";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set on the server`);
  return v;
};
const opt = (k: string, fallback: string) => process.env[k] || fallback;

export const serverEnv = {
  graphApiKey: () => need("GRAPH_API_KEY"),
  sepoliaRpc: () => opt("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
  baseRpc: () => opt("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
  hederaRpc: () => opt("HEDERA_JSON_RPC_URL", "https://testnet.hashio.io/api"),
  solanaRpc: () => opt("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
  subgraphSepolia: () => opt("SUBGRAPH_SEPOLIA_URL", "https://api.studio.thegraph.com/query/120234/agentrail/v0.1.0"),
  subgraphBase: () => opt("SUBGRAPH_BASE_URL", "https://api.studio.thegraph.com/query/120234/agentrail-base/v0.1.0"),
};

/** Public, on-chain facts (SPEC §8A). Safe anywhere. */
export const PUBLIC = {
  agentName: process.env.AGENT_ENS_NAME || "databot.agentrail.eth",
  serviceNames: (process.env.SERVICE_ENS_NAMES || "feed.agentrail.eth,graph.agentrail.eth").split(",").map((s) => s.trim()),
  rogueName: process.env.ROGUE_ENS_NAME || "rogue.agentrail.eth",
  ensNode: process.env.RAIL_NODE || "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae",
  evmMandate: "0x68822ce9109D9d71e99b07703cF6c851D0229AA9",
  registry: "0x68822ce9109D9d71e99b07703cF6c851D0229AA9",
  resolver: "0xbfce4e394832c879fd2d95dae4F02259AFd23C16",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  owner: process.env.DEPLOYER_ADDRESS || "0xAa4d6f945A57b972705712B5FbadE1Fd23521069",
  solanaOwner: process.env.SOLANA_WALLET_ADDRESS || "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb",
  solanaProgram: "GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj",
  devnetUsdc: process.env.DEVNET_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  hcsTopic: process.env.HCS_AUDIT_TOPIC_ID || "0.0.10440940",
  feedUrl: process.env.FEED_PUBLIC_URL || "https://agentrail-data-feed.onrender.com",
};
