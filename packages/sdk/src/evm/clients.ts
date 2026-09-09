/**
 * Concrete EVM plumbing for the Hedera and Base tails: a viem public+wallet pair as the gate
 * client, the x402 signers, and a helper to bootstrap a mandate from the owner's key.
 */
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import type { EvmGateClient } from "./gate.ts";
import { EVM_MANDATE_ABI } from "./abi.ts";

export const hederaTestnet: Chain = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
});

export { baseSepolia };

export interface EvmClients {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  gate: EvmGateClient;
}

/** One key, one chain: everything an EVM tail needs. */
export function createEvmClients(chain: Chain, rpcUrl: string, privateKey: Hex): EvmClients {
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const gate: EvmGateClient = {
    readContract: (args) => publicClient.readContract(args as any) as Promise<Hex>,
    writeContract: (args) => walletClient.writeContract({ ...(args as any), account, chain }),
    waitForTransactionReceipt: async ({ hash }) => {
      const r = await publicClient.waitForTransactionReceipt({ hash });
      return { status: r.status };
    },
  };
  return { publicClient, walletClient, account, gate };
}

/**
 * Owner-side helper: (re)issue the mandate and its first permission.
 *
 * Decisions are made on receipts, not on reads: some relays (Hedera's) answer `eth_call` and
 * `eth_estimateGas` from a mirror node that lags consensus, so a read can say "inactive" while
 * the chain says otherwise. Every write carries an explicit gas limit, so nothing is simulated
 * against stale state, and a reverted `createMandate` is answered with a revoke and one retry.
 */
export async function issueEvmMandate(
  owner: EvmClients,
  mandateContract: Address,
  agent: Address,
  ensNode: Hex,
  expiry: bigint,
  permission: { destination: Address; spendLimit: bigint; perTxLimit: bigint },
): Promise<{ mandateId: Hex; txs: Hex[] }> {
  const mandateId = (await owner.publicClient.readContract({
    address: mandateContract,
    abi: EVM_MANDATE_ABI,
    functionName: "mandateIdFor",
    args: [owner.account.address, agent],
  })) as Hex;
  const txs: Hex[] = [];
  const send = async (functionName: "createMandate" | "revokeMandate" | "addPermission", args: readonly unknown[]) => {
    const hash = await owner.walletClient.writeContract({
      address: mandateContract,
      abi: EVM_MANDATE_ABI,
      functionName,
      args: args as any,
      account: owner.account,
      chain: owner.walletClient.chain,
      gas: 400_000n,
    } as any);
    const receipt = await owner.publicClient.waitForTransactionReceipt({ hash });
    txs.push(hash);
    return receipt.status;
  };

  let status = await send("createMandate", [agent, ensNode, expiry]);
  if (status !== "success") {
    // A previous mandate for this (owner, agent) is live: retire it, then issue the new one.
    const revoked = await send("revokeMandate", [mandateId]);
    if (revoked !== "success") throw new Error(`revokeMandate reverted on ${owner.walletClient.chain?.name} (${txs.at(-1)})`);
    status = await send("createMandate", [agent, ensNode, expiry]);
    if (status !== "success") throw new Error(`createMandate reverted twice on ${owner.walletClient.chain?.name} (${txs.at(-1)})`);
  }
  const added = await send("addPermission", [mandateId, permission.destination, permission.spendLimit, permission.perTxLimit]);
  if (added !== "success") throw new Error(`addPermission reverted on ${owner.walletClient.chain?.name} (${txs.at(-1)})`);
  return { mandateId, txs };
}
