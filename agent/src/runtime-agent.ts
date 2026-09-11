/**
 * The runtime a *running* agent gets, built from the environment alone: the agent's own keys, the
 * mandates the owner already issued (read from each chain, never issued here), and Solana
 * read-only. This is what a browser-triggered run uses (GAP 3): no keypair files, no owner key,
 * no issuance, no revoke, no reissue, so a click on a public page can never make the owner sign.
 *
 * Where the server holds no key for a rail the name lists, that rail is reported and a payment on
 * it is refused as `no-mandate`; nothing is pretended. `createRuntime` in runtime.ts stays the
 * developer's harness (it issues mandates with the owner key and stages the attack demos).
 */
import { fetchHistory } from "@agentrail/query/src/history.ts";
import { AdapterRegistry, BaseAdapter, CHAINS, HederaAdapter, parseAllowed, type AllowedEntry, type FetchLike, type MandateRef } from "@agentrail/sdk";
import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";
import { EVM_MANDATE_ABI } from "@agentrail/sdk/src/evm/abi.ts";
import { baseSepolia, createEvmClients, hederaTestnet, type EvmClients } from "@agentrail/sdk/src/evm/clients.ts";
import idl from "@agentrail/sdk/src/solana/agentrail.idl.json" with { type: "json" };
import { createAnchorGateClient } from "@agentrail/sdk/src/solana/anchorClient.ts";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createClientHederaSigner, PrivateKey as X402PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { Address, Chain, Hex } from "viem";
import { namehash } from "viem/ens";

import { explore, messagesFromEnv, type Provider } from "./explore.ts";
import { connectSubgraphMcp, type SubgraphMcp } from "./mcp.ts";
import { createTools, type AgentTools, type SolanaRail, type ToolsConfig } from "./tools.ts";
import { RunLog } from "./transcript.ts";

export type RailState = "ready" | "read-only" | "no-key" | "key-mismatch" | "inactive" | "not-named";

export interface RailReport {
  chain: string;
  state: RailState;
  detail: string;
}

export interface AgentRuntimeOptions {
  /** The agent's ENS name; its keys and mandates are looked up from it. Default AGENT_ENS_NAME. */
  agentName?: string;
  log?: RunLog;
  fetch?: FetchLike;
  /** Connect the MCP and a model provider. Default true. */
  mcp?: boolean;
  /** Tool-call budget per explore loop. Default 12, as the CLI; a serverless run may spend less. */
  exploreSteps?: number;
  /** Characters of tool output the model sees per step. Default: the provider's. */
  toolResultChars?: number;
}

export interface AgentRuntime {
  tools: AgentTools;
  cfg: ToolsConfig;
  log: RunLog;
  agentName: string;
  ensNode: Hex;
  self: Record<string, string>;
  allowed: AllowedEntry[];
  mandates: Partial<Record<string, MandateRef>>;
  solana?: SolanaRail;
  feedService: string;
  /** What this server can pay on, and why it cannot on the rest. Reported, never faked. */
  rails: RailReport[];
  provider?: Provider;
  paidRequests(): number;
  close(): Promise<void>;
}

const DEMO_OWNER_EVM = "0xAa4d6f945A57b972705712B5FbadE1Fd23521069";
const DEMO_OWNER_SOLANA = "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb";
const EVM_MANDATE = "0x68822ce9109D9d71e99b07703cF6c851D0229AA9";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
};
const hexKey = (k: string) => (need(k).startsWith("0x") ? need(k) : `0x${need(k)}`) as Hex;

export async function createAgentRuntime(opts: AgentRuntimeOptions = {}): Promise<AgentRuntime> {
  const log = opts.log ?? new RunLog(undefined, false);
  const agentName = opts.agentName ?? process.env.AGENT_ENS_NAME ?? "databot.agentrail.eth";
  const ensNode = namehash(agentName) as Hex;
  const readText = sepoliaEnsReader(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");

  const self: Record<string, string> = {};
  for (const k of ["rail.agent.solana", "rail.agent.hedera", "rail.agent.base", "rail.erc8004", "rail.allowed", "rail.mandate.pda"]) self[k] = (await readText(agentName, k)) ?? "";
  const allowed = self["rail.allowed"] ? parseAllowed(self["rail.allowed"], agentName) : [];
  log.add("note", `${agentName}: rail.allowed has ${allowed.length} payee(s)`, { allowed: allowed.map((a) => `${a.chain} ${a.target} ${a.perTx ?? ""}/${a.total ?? ""}`) });

  // every outbound paid request is counted, so a refusal can prove that nothing was sent
  let paid = 0;
  const base: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const countingFetch: FetchLike = async (url, init) => {
    if (init?.headers?.["X-PAYMENT"] || init?.headers?.["PAYMENT-SIGNATURE"]) paid++;
    return base(url, init);
  };

  const rails: RailReport[] = [];
  const registry = new AdapterRegistry();
  const mandates: Partial<Record<string, MandateRef>> = {};

  // ---- Solana: the mandate and the delegation are read live; this server signs nothing there -----
  let solana: SolanaRail | undefined;
  if (self["rail.agent.solana"]) {
    const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const owner = new PublicKey(process.env.SOLANA_WALLET_ADDRESS ?? DEMO_OWNER_SOLANA);
    const agent = new PublicKey(self["rail.agent.solana"]);
    const programId = new PublicKey((idl as { address: string }).address);
    const usdc = new PublicKey(process.env.DEVNET_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const ownerTokenAccount = getAssociatedTokenAddressSync(usdc, owner);
    const pda = self["rail.mandate.pda"] ? new PublicKey(self["rail.mandate.pda"]) : PublicKey.findProgramAddressSync([Buffer.from("mandate"), owner.toBuffer(), agent.toBuffer()], programId)[0];
    // a throwaway keypair satisfies the client's constructor; nothing it signs is ever sent
    const client = createAnchorGateClient({ connection, agent: Keypair.generate(), ownerTokenAccount });
    solana = {
      client,
      agent: agent.toBase58(),
      mandate: pda.toBase58(),
      owner: owner.toBase58(),
      ownerTokenAccount: ownerTokenAccount.toBase58(),
      asset: usdc.toBase58(),
      async readDelegation() {
        const acc = await getAccount(connection, ownerTokenAccount);
        const delegate = acc.delegate?.toBase58() ?? null;
        let delegateTxCount: number | null = null;
        if (delegate && delegate !== pda.toBase58()) {
          const sigs = await connection.getSignaturesForAddress(new PublicKey(delegate), { limit: 10 }).catch(() => null);
          delegateTxCount = sigs ? sigs.length : null;
        }
        return { delegate, delegatedAmount: acc.delegatedAmount, balance: acc.amount, delegateTxCount };
      },
    };
    rails.push({ chain: CHAINS.SOLANA_DEVNET, state: "read-only", detail: `mandate ${pda.toBase58()} read live; this server holds no Solana key, so a payment there is refused` });
  } else {
    rails.push({ chain: CHAINS.SOLANA_DEVNET, state: "not-named", detail: "the name carries no rail.agent.solana" });
  }

  // ---- EVM rails: the agent's key from the environment, the mandate the owner already issued ----
  const ownerEvm = (process.env.DEPLOYER_ADDRESS ?? DEMO_OWNER_EVM) as Address;
  const evmRail = async (chain: string, named: string, keyVar: string, rpc: string, contract: Address, chainDef: Chain, register: (agent: EvmClients, id: Hex) => void) => {
    if (!named) {
      rails.push({ chain, state: "not-named", detail: `the name carries no agent key for ${chain}` });
      return;
    }
    if (!process.env[keyVar]) {
      rails.push({ chain, state: "no-key", detail: `this server holds no key for ${named}; a payment on ${chain} is refused` });
      return;
    }
    const agent = createEvmClients(chainDef, rpc, hexKey(keyVar));
    if (agent.account.address.toLowerCase() !== named.toLowerCase()) {
      rails.push({ chain, state: "key-mismatch", detail: `the server's key is ${agent.account.address}, the name says ${named}; a payment on ${chain} is refused` });
      return;
    }
    const id = (await agent.publicClient.readContract({ address: contract, abi: EVM_MANDATE_ABI, functionName: "mandateIdFor", args: [ownerEvm, agent.account.address] })) as Hex;
    const [, , , expiry, active] = await agent.publicClient.readContract({ address: contract, abi: EVM_MANDATE_ABI, functionName: "getMandate", args: [id] });
    if (!active || Number(expiry) <= Math.floor(Date.now() / 1000)) {
      rails.push({ chain, state: "inactive", detail: `no active mandate for ${agent.account.address} on ${chain}: the owner has not issued one, or revoked it` });
      return;
    }
    mandates[chain] = { chain: chain as MandateRef["chain"], id };
    register(agent, id);
    rails.push({ chain, state: "ready", detail: `mandate ${id}` });
  };

  const hederaContract = (process.env.EVM_MANDATE_HEDERA ?? EVM_MANDATE) as Address;
  const baseContract = (process.env.EVM_MANDATE_BASE_SEPOLIA ?? EVM_MANDATE) as Address;
  // the two rails are read together: each is a couple of RPC round trips on a relay that can be slow
  await Promise.all([
  evmRail(CHAINS.HEDERA_TESTNET, self["rail.agent.hedera"], "HEDERA_PRIVATE_KEY", process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api", hederaContract, hederaTestnet, (agent) => {
    registry.register(CHAINS.HEDERA_TESTNET, () => new HederaAdapter({
      mandateContract: hederaContract,
      agent: agent.account.address,
      client: agent.gate,
      signer: new ExactHederaScheme(createClientHederaSigner(need("HEDERA_ACCOUNT_ID"), X402PrivateKey.fromStringECDSA(need("HEDERA_PRIVATE_KEY")), { network: "hedera:testnet" })),
      fetch: countingFetch,
    }));
  }),
  evmRail(CHAINS.BASE_SEPOLIA, self["rail.agent.base"], "AGENT_EVM_PRIVATE_KEY", process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org", baseContract, baseSepolia, (agent) => {
    registry.register(CHAINS.BASE_SEPOLIA, () => new BaseAdapter({
      mandateContract: baseContract,
      agent: agent.account.address,
      client: agent.gate,
      signer: new ExactEvmScheme(toClientEvmSigner(agent.account as any, agent.publicClient as any)),
      fetch: countingFetch,
    }));
  }),
  ]);
  rails.sort((a, b) => a.chain.localeCompare(b.chain));
  log.add("note", `rails: ${rails.map((r) => `${r.chain} ${r.state}`).join(" · ")}`, { rails });

  // ---- the MCP and the model, for exploring other people's subgraphs ----------------------------
  let mcp: SubgraphMcp | undefined;
  let provider: Provider | undefined;
  if (opts.mcp !== false) {
    mcp = await connectSubgraphMcp(need("GRAPH_API_KEY"));
    provider = messagesFromEnv();
    log.add("note", `subgraph-mcp connected: ${mcp.tools.length} tools; model ${provider.model}`);
  }
  const exploreFn: ToolsConfig["explore"] = async (question, hooks) => {
    if (!mcp || !provider) throw new Error("the MCP is not connected in this runtime");
    return explore(question, mcp, provider.api, provider.model, opts.exploreSteps ?? 12, opts.toolResultChars ?? provider.toolResultChars, hooks?.onStep);
  };

  // ---- the fixed query --------------------------------------------------------------------------
  const history = (node: string) => fetchHistory(node, { sepoliaUrl: need("SUBGRAPH_SEPOLIA_URL"), baseUrl: need("SUBGRAPH_BASE_URL"), apiKey: need("GRAPH_API_KEY") });

  const cfg: ToolsConfig = { agentName, ensNode, readText, explore: exploreFn, history, registry, mandates, allowed, solana, paidRequests: () => paid, log };
  const services = (process.env.SERVICE_ENS_NAMES ?? "feed.agentrail.eth,graph.agentrail.eth").split(",").map((s) => s.trim());
  return {
    tools: createTools(cfg),
    cfg,
    log,
    agentName,
    ensNode,
    self,
    allowed,
    mandates,
    solana,
    feedService: services.find((s) => s.startsWith("feed.")) ?? services[0],
    rails,
    provider,
    paidRequests: () => paid,
    close: async () => {
      await mcp?.close();
    },
  };
}
