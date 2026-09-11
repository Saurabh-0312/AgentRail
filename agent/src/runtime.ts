/**
 * From .env to real tools. Everything the agent touches is built here, once, in the open:
 *
 *   ENS         the agent's own name -> rail.allowed (what it may buy), rail.agent.* (its keys)
 *   MCP         the Subgraph MCP with a Graph API key, driven by the model provider from the env
 *   history     the fixed query over the two Studio endpoints and the Solana sink
 *   rails       Hedera (and optionally Base): the owner issues a mandate from rail.allowed caps;
 *               Solana: the mandate PDA from demo:devnet, with Alice's wallet as fee payer
 *   alert       the HCS audit topic
 *
 * The agent key on Solana holds nothing and signs only `execute_payment` / `verify`. The owner key
 * appears only where Alice acts: issuing mandates and paying fees.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
import { fetchHistory } from "@agentrail/query/src/history.ts";
import { AdapterRegistry, BaseAdapter, CHAINS, HederaAdapter, SPL_TOKEN_TAG, SolanaAdapter, hederaLongZeroAddress, parseAllowed, type AllowedEntry, type FetchLike, type MandateRef } from "@agentrail/sdk";
import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";
import { baseSepolia, createEvmClients, hederaTestnet, issueEvmMandate } from "@agentrail/sdk/src/evm/clients.ts";
import idl from "@agentrail/sdk/src/solana/agentrail.idl.json" with { type: "json" };
import { createAnchorGateClient } from "@agentrail/sdk/src/solana/anchorClient.ts";
import { approve, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createClientHederaSigner, PrivateKey as X402PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { Address, Hex } from "viem";

import { hcsAlert } from "./alert.ts";
import { explore, messagesFromEnv, type Provider } from "./explore.ts";
import { connectSubgraphMcp, type SubgraphMcp } from "./mcp.ts";
import type { AlertFn } from "./response.ts";
import { createTools, type AgentTools, type SolanaRail, type ToolsConfig } from "./tools.ts";
import { RunLog } from "./transcript.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");

export const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
};
const hex = (k: string) => (env(k).startsWith("0x") ? env(k) : `0x${env(k)}`) as Hex;
const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
export const loadKeypair = (file: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));

export interface SolanaRuntime extends SolanaRail {
  connection: Connection;
  ownerKeypair: Keypair;
  agentKeypair: Keypair;
  programId: PublicKey;
  usdc: PublicKey;
  /** The shop the mandate really does allow to be paid; the `replay` attack needs a legitimate payee. */
  shopWallet: string;
  /** Owner revokes the mandate (for the "after revocation" attack). Returns the signature. */
  revokeMandate(): Promise<string>;
  /**
   * Owner re-issues the demo mandate exactly as `yarn demo:devnet` leaves it: a payment permission
   * for the shop, the SPL delegate approval, and an SPL-Token Transfer-only permission. Leaves state
   * healthy after the revocation attack.
   */
  reissueMandate(): Promise<{ create: string; permission: string; approve: string; tokenPermission: string }>;
  /**
   * Alice signs a malicious delegation on her own token account: the phishing event itself, staged
   * on chain so the monitor detects a real drainer approval and not a fixture. The delegate is a key
   * nobody holds, so nothing can actually move; it replaces the mandate PDA until `restoreDelegate`.
   */
  stageDrainerApproval(delegate: string, amount?: bigint): Promise<string>;
  /** Alice re-approves the mandate PDA as delegate, undoing the staged phishing. */
  restoreDelegate(amount?: bigint): Promise<string>;
  /** Alice widens or narrows which SPL Token instructions the mandate permits (remove, then re-add). */
  setTokenInstructions(tags: number[]): Promise<{ removed: string; added: string }>;
}

export interface Runtime {
  tools: AgentTools;
  cfg: ToolsConfig;
  log: RunLog;
  agentName: string;
  ensNode: Hex;
  /** rail.* records of the agent's own name, as read. */
  self: Record<string, string>;
  allowed: AllowedEntry[];
  mandates: Partial<Record<string, MandateRef>>;
  solana: SolanaRuntime;
  /** The price feed's ENS name (first feed.* in SERVICE_ENS_NAMES). */
  feedService: string;
  alert?: AlertFn;
  provider?: Provider;
  paidRequests(): number;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  log?: RunLog;
  /** When the local gate refuses on Solana, send anyway so the chain's refusal is on record. */
  proveOnChain?: boolean;
  /** EVM rails to set up; the owner issues a mandate for each from rail.allowed. Default: hedera. */
  evmRails?: ("hedera" | "base")[];
  /** Outbound HTTP for the paid services (the attack harness plants its payload here). */
  fetch?: FetchLike;
  /** Connect the MCP and a model provider. Default true. */
  mcp?: boolean;
}

export async function createRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const log = opts.log ?? new RunLog();
  const agentName = process.env.AGENT_ENS_NAME ?? "databot.agentrail.eth";
  const ensNode = env("RAIL_NODE") as Hex;
  const readText = sepoliaEnsReader(env("SEPOLIA_RPC_URL"));

  // the agent resolves itself: what it may buy, which keys are its own
  const self: Record<string, string> = {};
  for (const k of ["rail.agent.solana", "rail.agent.hedera", "rail.agent.base", "rail.erc8004", "rail.allowed"]) self[k] = (await readText(agentName, k)) ?? "";
  const allowed = parseAllowed(self["rail.allowed"], agentName);
  log.add("note", `${agentName}: rail.allowed has ${allowed.length} payee(s)`, { allowed: allowed.map((a) => `${a.chain} ${a.target} ${a.perTx ?? ""}/${a.total ?? ""}`) });

  // every outbound paid request is counted, so a refusal can prove that nothing was sent
  let paid = 0;
  const base: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const countingFetch: FetchLike = async (url, init) => {
    if (init?.headers?.["X-PAYMENT"] || init?.headers?.["PAYMENT-SIGNATURE"]) paid++;
    return base(url, init);
  };

  // ---- Solana: Alice's delegated account and the mandate from demo:devnet -----------------------
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const ownerKeypair = loadKeypair(expand(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json"));
  const agentKeypair = loadKeypair(path.join(ROOT, "scripts/keys/agent-keypair.json"));
  const programId = new PublicKey((idl as { address: string }).address);
  const usdc = new PublicKey(process.env.DEVNET_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const ownerTokenAccount = getAssociatedTokenAddressSync(usdc, ownerKeypair.publicKey);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("mandate"), ownerKeypair.publicKey.toBuffer(), agentKeypair.publicKey.toBuffer()], programId);
  if (self["rail.agent.solana"] && self["rail.agent.solana"] !== agentKeypair.publicKey.toBase58()) throw new Error(`agent keypair ${agentKeypair.publicKey.toBase58()} is not rail.agent.solana ${self["rail.agent.solana"]}`);
  // Anchor pins its own copy of @solana/web3.js, so TypeScript sees two declarations of the same classes
  const solanaClient = createAnchorGateClient({ connection: connection as never, agent: agentKeypair as never, feePayer: ownerKeypair as never, ownerTokenAccount });

  // Owner-signed program handle, for the revoke/reissue the attack demo needs (Alice acts, not the agent).
  const ownerProgram = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(connection as never, new anchor.Wallet(ownerKeypair as never), { commitment: "confirmed" }));
  const ownerMethods = ownerProgram.methods as any;
  const USDC_UNIT = 1_000_000;
  const shopKeypair = loadKeypair(path.join(ROOT, "scripts/keys/shop-keypair.json"));
  const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const transferSlot = Array.from(Buffer.alloc(8).fill(0).map((_, i) => (i === 0 ? SPL_TOKEN_TAG.transfer : 0)));

  const solana: SolanaRuntime = {
    client: solanaClient,
    agent: agentKeypair.publicKey.toBase58(),
    mandate: pda.toBase58(),
    owner: ownerKeypair.publicKey.toBase58(),
    ownerTokenAccount: ownerTokenAccount.toBase58(),
    asset: usdc.toBase58(),
    connection,
    ownerKeypair,
    agentKeypair,
    programId,
    usdc,
    shopWallet: shopKeypair.publicKey.toBase58(),
    async readDelegation() {
      const acc = await getAccount(connection, ownerTokenAccount);
      const delegate = acc.delegate?.toBase58() ?? null;
      let delegateTxCount: number | null = null;
      if (delegate && delegate !== pda.toBase58()) {
        // a fresh drainer key has never been part of a transaction; the count is capped at 10
        const sigs = await connection.getSignaturesForAddress(new PublicKey(delegate), { limit: 10 }).catch(() => null);
        delegateTxCount = sigs ? sigs.length : null;
      }
      return { delegate, delegatedAmount: acc.delegatedAmount, balance: acc.amount, delegateTxCount };
    },
    async revokeMandate() {
      return ownerMethods.revokeMandate().accountsStrict({ mandate: pda, owner: ownerKeypair.publicKey }).rpc();
    },
    async reissueMandate() {
      const shopAta = await getOrCreateAssociatedTokenAccount(connection, ownerKeypair, usdc, shopKeypair.publicKey);
      const expirySec = new anchor.BN(Math.floor(Date.now() / 1000) + 24 * 3600);
      const node = Array.from(Buffer.from(ensNode.replace(/^0x/, ""), "hex"));
      const create = await ownerMethods.createMandate(node, expirySec).accountsStrict({ mandate: pda, owner: ownerKeypair.publicKey, agent: agentKeypair.publicKey, systemProgram: SystemProgram.programId }).rpc();
      const permission = await ownerMethods.addPermission(shopAta.address, [], 1, new anchor.BN(5 * USDC_UNIT), new anchor.BN(2 * USDC_UNIT)).accountsStrict({ mandate: pda, owner: ownerKeypair.publicKey }).rpc();
      const approveSig = await approve(connection, ownerKeypair, ownerTokenAccount, pda, ownerKeypair, 100 * USDC_UNIT);
      const tokenPermission = await ownerMethods.addPermission(SPL_TOKEN_PROGRAM_ID, [transferSlot], 1, new anchor.BN(2 * USDC_UNIT), new anchor.BN(1 * USDC_UNIT)).accountsStrict({ mandate: pda, owner: ownerKeypair.publicKey }).rpc();
      return { create, permission, approve: approveSig, tokenPermission };
    },
    async stageDrainerApproval(delegate, amount = (1n << 64n) - 1n) {
      // An unlimited approval is the real drainer signature: the phishing page asks for u64::MAX so
      // the delegate can take everything later, in its own transaction, whenever it likes.
      return approve(connection, ownerKeypair, ownerTokenAccount, new PublicKey(delegate), ownerKeypair, amount);
    },
    async restoreDelegate(amount = BigInt(100 * USDC_UNIT)) {
      return approve(connection, ownerKeypair, ownerTokenAccount, pda, ownerKeypair, amount);
    },
    async setTokenInstructions(tags) {
      const slots = tags.map((t) => Array.from(Buffer.alloc(8).fill(0).map((_, i) => (i === 0 ? t : 0))));
      const removed = await ownerMethods.removePermission(SPL_TOKEN_PROGRAM_ID).accountsStrict({ mandate: pda, owner: ownerKeypair.publicKey }).rpc();
      const added = await ownerMethods.addPermission(SPL_TOKEN_PROGRAM_ID, slots, 1, new anchor.BN(2 * USDC_UNIT), new anchor.BN(1 * USDC_UNIT)).accountsStrict({ mandate: pda, owner: ownerKeypair.publicKey }).rpc();
      return { removed, added };
    },
  };
  const mandates: Partial<Record<string, MandateRef>> = { [CHAINS.SOLANA_DEVNET]: { chain: CHAINS.SOLANA_DEVNET, id: solana.mandate } };
  const registry = new AdapterRegistry().register(CHAINS.SOLANA_DEVNET, () => new SolanaAdapter({ agent: solana.agent, client: solanaClient, fetch: countingFetch }));

  // ---- EVM rails: the owner issues each mandate from the caps published in rail.allowed ----------
  const rails = opts.evmRails ?? ["hedera"];
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const capsFor = (entry: AllowedEntry) => {
    if (!entry.perTx || !entry.total) throw new Error(`rail.allowed has no caps for ${entry.chain} ${entry.target}`);
    return { perTxLimit: BigInt(entry.perTx), spendLimit: BigInt(entry.total) };
  };
  if (rails.includes("hedera")) {
    const entry = allowed.find((a) => a.chain === CHAINS.HEDERA_TESTNET);
    if (!entry) throw new Error("rail.allowed has no hedera:testnet payee");
    const owner = createEvmClients(hederaTestnet, env("HEDERA_JSON_RPC_URL"), hex("DEPLOYER_PRIVATE_KEY"));
    const agent = createEvmClients(hederaTestnet, env("HEDERA_JSON_RPC_URL"), hex("HEDERA_PRIVATE_KEY"));
    if (self["rail.agent.hedera"] && agent.account.address.toLowerCase() !== self["rail.agent.hedera"].toLowerCase()) throw new Error("Hedera key does not match rail.agent.hedera");
    const contract = env("EVM_MANDATE_HEDERA") as Address;
    const issued = await issueEvmMandate(owner, contract, agent.account.address, ensNode, expiry, { destination: hederaLongZeroAddress(entry.target), ...capsFor(entry) });
    log.add("note", `owner issued the Hedera mandate ${issued.mandateId} from rail.allowed (${entry.perTx}/${entry.total} to ${entry.target})`, { txs: issued.txs });
    mandates[CHAINS.HEDERA_TESTNET] = { chain: CHAINS.HEDERA_TESTNET, id: issued.mandateId };
    registry.register(CHAINS.HEDERA_TESTNET, () => new HederaAdapter({
      mandateContract: contract,
      agent: agent.account.address,
      client: agent.gate,
      signer: new ExactHederaScheme(createClientHederaSigner(env("HEDERA_ACCOUNT_ID"), X402PrivateKey.fromStringECDSA(env("HEDERA_PRIVATE_KEY")), { network: "hedera:testnet" })),
      fetch: countingFetch,
    }));
  }
  if (rails.includes("base")) {
    const entry = allowed.find((a) => a.chain === CHAINS.BASE_SEPOLIA);
    if (!entry) throw new Error("rail.allowed has no eip155:84532 payee");
    const owner = createEvmClients(baseSepolia, env("BASE_SEPOLIA_RPC_URL"), hex("DEPLOYER_PRIVATE_KEY"));
    const agent = createEvmClients(baseSepolia, env("BASE_SEPOLIA_RPC_URL"), hex("AGENT_EVM_PRIVATE_KEY"));
    const contract = env("EVM_MANDATE_BASE_SEPOLIA") as Address;
    const issued = await issueEvmMandate(owner, contract, agent.account.address, ensNode, expiry, { destination: entry.target as Address, ...capsFor(entry) });
    log.add("note", `owner issued the Base mandate ${issued.mandateId} from rail.allowed`, { txs: issued.txs });
    mandates[CHAINS.BASE_SEPOLIA] = { chain: CHAINS.BASE_SEPOLIA, id: issued.mandateId };
    registry.register(CHAINS.BASE_SEPOLIA, () => new BaseAdapter({
      mandateContract: contract,
      agent: agent.account.address,
      client: agent.gate,
      signer: new ExactEvmScheme(toClientEvmSigner(agent.account as any, agent.publicClient as any)),
      fetch: countingFetch,
    }));
  }

  // ---- the MCP and the model, for exploring other people's subgraphs ----------------------------
  let mcp: SubgraphMcp | undefined;
  let provider: Provider | undefined;
  if (opts.mcp !== false) {
    mcp = await connectSubgraphMcp(env("GRAPH_API_KEY"));
    provider = messagesFromEnv();
    log.add("note", `subgraph-mcp connected: ${mcp.tools.length} tools; model ${provider.model}`);
  }
  const exploreFn: ToolsConfig["explore"] = async (question, hooks) => {
    if (!mcp || !provider) throw new Error("the MCP is not connected in this runtime");
    // The discovery pass often needs several searches and a schema read before it can answer, so the
    // step budget has to leave room for the answer itself; at 8 it spends them all on tool calls.
    return explore(question, mcp, provider.api, provider.model, 12, provider.toolResultChars, hooks?.onStep);
  };

  // ---- the fixed query --------------------------------------------------------------------------
  const history = (node: string) => fetchHistory(node, { sepoliaUrl: env("SUBGRAPH_SEPOLIA_URL"), baseUrl: env("SUBGRAPH_BASE_URL"), apiKey: env("GRAPH_API_KEY") });

  const alert = process.env.HCS_AUDIT_TOPIC_ID ? hcsAlert({ accountId: env("HEDERA_ACCOUNT_ID"), privateKey: env("HEDERA_PRIVATE_KEY"), topicId: process.env.HCS_AUDIT_TOPIC_ID, agentName }) : undefined;

  const cfg: ToolsConfig = { agentName, ensNode, readText, explore: exploreFn, history, registry, mandates, allowed, solana, paidRequests: () => paid, proveOnChain: opts.proveOnChain, log };
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
    alert,
    provider,
    paidRequests: () => paid,
    close: async () => {
      await mcp?.close();
    },
  };
}
