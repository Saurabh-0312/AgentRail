/**
 * The real readers behind the tools: ENS through the SDK, the two Studio endpoints and the Solana
 * leg through @agentrail/query, the live mandates through plain RPC reads. Every URL and key comes
 * from the environment the MCP client passes; nothing here can sign.
 */
import * as fs from "node:fs";

import { fetchHistory } from "@agentrail/query/src/history.ts";
import { readRows, type SolanaRow } from "@agentrail/query/src/solana-sink.ts";
import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";
import { EVM_MANDATE_ABI, EVM_MANDATE_ERRORS, NO_ERROR } from "@agentrail/sdk/src/evm/abi.ts";
import { hederaTestnet } from "@agentrail/sdk/src/evm/clients.ts";
import { createAnchorGateClient } from "@agentrail/sdk/src/solana/anchorClient.ts";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

import type { Deps, EvmMandateView } from "./tools.ts";

const opt = (env: NodeJS.ProcessEnv, k: string, fallback: string) => env[k] || fallback;

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  const owner = opt(env, "DEPLOYER_ADDRESS", "0xAa4d6f945A57b972705712B5FbadE1Fd23521069") as Address;
  const evmMandate = opt(env, "EVM_MANDATE_ADDRESS", "0x68822ce9109D9d71e99b07703cF6c851D0229AA9") as Address;
  const usdc = new PublicKey(opt(env, "DEVNET_USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"));
  const solanaOwner = opt(env, "SOLANA_WALLET_ADDRESS", "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb");
  const rpc = { sepolia: opt(env, "SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"), base: opt(env, "BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"), hedera: opt(env, "HEDERA_JSON_RPC_URL", "https://testnet.hashio.io/api"), solana: opt(env, "SOLANA_RPC_URL", "https://api.devnet.solana.com") };

  const evmClient = (chain: "hedera" | "base") => createPublicClient({ chain: chain === "hedera" ? hederaTestnet : baseSepolia, transport: http(chain === "hedera" ? rpc.hedera : rpc.base) });

  // The Solana leg of the history: a snapshot file when one is configured (hosted use), else the
  // reader's local sink. Both are caches of the same provider stream.
  const solanaRows = (): SolanaRow[] => {
    const snap = env.AGENTRAIL_SOLANA_SNAPSHOT;
    if (snap && fs.existsSync(snap)) return (JSON.parse(fs.readFileSync(snap, "utf8")) as { rows: SolanaRow[] }).rows;
    return readRows();
  };

  return {
    agentName: opt(env, "AGENT_ENS_NAME", "databot.agentrail.eth"),
    serviceNames: [...opt(env, "SERVICE_ENS_NAMES", "feed.agentrail.eth,graph.agentrail.eth").split(","), opt(env, "ROGUE_ENS_NAME", "rogue.agentrail.eth")].map((s) => s.trim()).filter(Boolean),
    owner: { solana: solanaOwner },
    readText: sepoliaEnsReader(rpc.sepolia),
    now: () => BigInt(Math.floor(Date.now() / 1000)),
    history: (ensNode) => {
      const apiKey = env.GRAPH_API_KEY;
      if (!apiKey) throw new Error("GRAPH_API_KEY is required for get_history (Subgraph Studio)");
      return fetchHistory(ensNode, { sepoliaUrl: opt(env, "SUBGRAPH_SEPOLIA_URL", "https://api.studio.thegraph.com/query/120234/agentrail/v0.1.0"), baseUrl: opt(env, "SUBGRAPH_BASE_URL", "https://api.studio.thegraph.com/query/120234/agentrail-base/v0.1.0"), apiKey, solanaRows });
    },
    solanaDestination: (payTo) => getAssociatedTokenAddressSync(usdc, new PublicKey(payTo), true).toBase58(),
    readSolana: async (pda) => {
      const connection = new Connection(rpc.solana, "confirmed");
      // read-only: the throwaway keypair only satisfies Anchor's provider and never signs
      const client = createAnchorGateClient({ connection, agent: Keypair.generate(), ownerTokenAccount: getAssociatedTokenAddressSync(usdc, new PublicKey(solanaOwner)) });
      return client.readMandate(pda);
    },
    readEvm: async (chain, agent): Promise<EvmMandateView> => {
      const client = evmClient(chain);
      const id = await client.readContract({ address: evmMandate, abi: EVM_MANDATE_ABI, functionName: "mandateIdFor", args: [owner, agent as Address] });
      const [mOwner, mAgent, , expiry, active] = await client.readContract({ address: evmMandate, abi: EVM_MANDATE_ABI, functionName: "getMandate", args: [id] });
      const exists = mOwner !== "0x0000000000000000000000000000000000000000";
      const destinations = exists ? await client.readContract({ address: evmMandate, abi: EVM_MANDATE_ABI, functionName: "getDestinations", args: [id] }) : [];
      const permissions = [];
      for (const d of destinations) {
        const p = await client.readContract({ address: evmMandate, abi: EVM_MANDATE_ABI, functionName: "getPermission", args: [id, d] });
        if (p.exists) permissions.push({ target: d, perTx: p.perTxLimit.toString(), total: p.spendLimit.toString(), spent: p.spendTotal.toString() });
      }
      return { id, exists, active: exists && active, expiry: Number(expiry), agent: exists ? mAgent : agent, permissions };
    },
    evmCheck: async (chain, mandateId, agent, destination, amount) => {
      const selector = (await evmClient(chain).readContract({ address: evmMandate, abi: EVM_MANDATE_ABI, functionName: "check", args: [mandateId as Hex, agent as Address, destination as Address, amount] })) as Hex;
      return selector === NO_ERROR ? "ok" : (EVM_MANDATE_ERRORS[selector] ?? selector);
    },
  };
}
