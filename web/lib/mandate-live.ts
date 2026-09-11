/**
 * The mandate as it is right now, read from each chain on the server. The index (history.ts) is
 * the record of what happened; these reads are the current caps, spend and delegate, so the agent
 * page can show live headroom rather than a stale total. Every read is a plain RPC call with no
 * key; the RPC URLs stay in the server environment.
 */
import "server-only";

import { EVM_MANDATE_ABI } from "@agentrail/sdk/src/evm/abi.ts";
import { hederaTestnet } from "@agentrail/sdk/src/evm/clients.ts";
import { createAnchorGateClient } from "@agentrail/sdk/src/solana/anchorClient.ts";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createPublicClient, erc20Abi, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

import { CHAINS, type ChainKey } from "./chains";
import { requiredAllowance, type Funding } from "./delegation";
import { PUBLIC, serverEnv } from "./env";
import { tokenFor } from "./tokens";

export interface LivePermission {
  target: string;
  perTx: string;
  total: string;
  spent: string;
  callCount: number | null;
  /** Instruction-keyed entries (Solana `verify`): allowed discriminators as hex. */
  instructions: string[];
}

export interface LiveMandate {
  chain: ChainKey;
  /** bytes32 mandate id (EVM) or the PDA (Solana). */
  id: string;
  contract: string;
  exists: boolean;
  active: boolean;
  expiry: number;
  owner: string | null;
  agent: string | null;
  permissions: LivePermission[];
  readAt: string;
  explorer: string;
  error?: string;
  /** EVM only: the owner's allowance to the contract in the chain's token, next to what the caps need. */
  funding?: Funding;
  fundingError?: string;
}

export interface SolanaDelegation {
  account: string;
  balance: string;
  delegate: string | null;
  delegatedAmount: string;
  delegateIsMandate: boolean;
}

const nowIso = () => new Date().toISOString();

export async function readEvmMandate(chain: "hedera" | "base", agent: Address): Promise<LiveMandate> {
  const contract = PUBLIC.evmMandate as Address;
  const base: LiveMandate = { chain, id: "", contract, exists: false, active: false, expiry: 0, owner: null, agent, permissions: [], readAt: nowIso(), explorer: CHAINS[chain].address(contract) };
  try {
    const client = createPublicClient({ chain: chain === "hedera" ? hederaTestnet : baseSepolia, transport: http(chain === "hedera" ? serverEnv.hederaRpc() : serverEnv.baseRpc()) });
    const id = (await client.readContract({ address: contract, abi: EVM_MANDATE_ABI, functionName: "mandateIdFor", args: [PUBLIC.owner as Address, agent] })) as Hex;
    const [owner, mandateAgent, , expiry, active] = await client.readContract({ address: contract, abi: EVM_MANDATE_ABI, functionName: "getMandate", args: [id] });
    const exists = owner !== "0x0000000000000000000000000000000000000000";
    const destinations = exists ? await client.readContract({ address: contract, abi: EVM_MANDATE_ABI, functionName: "getDestinations", args: [id] }) : [];
    const permissions: LivePermission[] = [];
    for (const d of destinations) {
      const p = await client.readContract({ address: contract, abi: EVM_MANDATE_ABI, functionName: "getPermission", args: [id, d] });
      if (p.exists) permissions.push({ target: d, perTx: p.perTxLimit.toString(), total: p.spendLimit.toString(), spent: p.spendTotal.toString(), callCount: Number(p.callCount), instructions: [] });
    }
    // executePayment pulls with transferFrom, so the allowance the owner granted the contract is
    // what the mandate can actually pay; read it next to the caps so an unfunded mandate is visible
    let funding: Funding | undefined;
    let fundingError: string | undefined;
    const token = tokenFor(chain);
    if (exists && token) {
      try {
        const [allowance, balance] = await Promise.all([
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance", args: [owner, contract] }),
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        ]);
        funding = { token: token.address, symbol: token.asset.symbol, decimals: token.asset.decimals, allowance: allowance.toString(), balance: balance.toString(), required: requiredAllowance(permissions) };
      } catch (e) {
        fundingError = e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e);
      }
    }
    return { ...base, id, exists, active: exists && active, expiry: Number(expiry), owner: exists ? owner : null, agent: exists ? mandateAgent : agent, permissions, funding, fundingError };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The mandate PDA for (owner, agent), the seeds the program uses. */
export function solanaPda(owner: string, agent: string): string {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("mandate"), new PublicKey(owner).toBuffer(), new PublicKey(agent).toBuffer()], new PublicKey(PUBLIC.solanaProgram));
  return pda.toBase58();
}

export async function readSolanaMandate(pda: string, agent: string | null): Promise<LiveMandate & { delegation?: SolanaDelegation }> {
  const base: LiveMandate = { chain: "solana", id: pda, contract: PUBLIC.solanaProgram, exists: false, active: false, expiry: 0, owner: PUBLIC.solanaOwner, agent, permissions: [], readAt: nowIso(), explorer: CHAINS.solana.address(pda) };
  try {
    const connection = new Connection(serverEnv.solanaRpc(), "confirmed");
    // A read-only client: the throwaway keypair signs nothing, it only satisfies Anchor's provider.
    const client = createAnchorGateClient({ connection, agent: Keypair.generate(), ownerTokenAccount: PublicKey.default });
    const state = await client.readMandate(pda);
    const ownerAta = getAssociatedTokenAddressSync(new PublicKey(PUBLIC.devnetUsdc), new PublicKey(PUBLIC.solanaOwner));
    let delegation: SolanaDelegation | undefined;
    try {
      const acc = await getAccount(connection, ownerAta);
      const delegate = acc.delegate?.toBase58() ?? null;
      delegation = { account: ownerAta.toBase58(), balance: acc.amount.toString(), delegate, delegatedAmount: acc.delegatedAmount.toString(), delegateIsMandate: delegate === pda };
    } catch {
      delegation = undefined;
    }
    if (!state) return { ...base, delegation };
    const permissions = state.permissions.map((p) => ({ target: p.key, perTx: p.perTxLimit.toString(), total: p.spendLimit.toString(), spent: p.spendTotal.toString(), callCount: null, instructions: p.discriminators ?? [] }));
    // the SPL delegation is Solana's allowance: what the PDA may move from the owner's account
    const funding: Funding | undefined = delegation
      ? { token: PUBLIC.devnetUsdc, symbol: "USDC", decimals: 6, allowance: delegation.delegateIsMandate ? delegation.delegatedAmount : "0", balance: delegation.balance, required: requiredAllowance(permissions) }
      : undefined;
    return {
      ...base,
      exists: true,
      active: state.active,
      expiry: Number(state.expiry),
      agent: state.agent,
      permissions,
      delegation,
      funding,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
