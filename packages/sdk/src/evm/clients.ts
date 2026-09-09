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

/** Owner-side helper: create the mandate and its first permission in two transactions. */
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
  const [, , , , active] = (await owner.publicClient.readContract({
    address: mandateContract,
    abi: EVM_MANDATE_ABI,
    functionName: "getMandate",
    args: [mandateId],
  })) as readonly [Address, Address, Hex, bigint, boolean, bigint];
  if (active) {
    const h = await owner.walletClient.writeContract({ address: mandateContract, abi: EVM_MANDATE_ABI, functionName: "revokeMandate", args: [mandateId], account: owner.account, chain: owner.walletClient.chain });
    await owner.publicClient.waitForTransactionReceipt({ hash: h });
    txs.push(h);
  }
  const h1 = await owner.walletClient.writeContract({ address: mandateContract, abi: EVM_MANDATE_ABI, functionName: "createMandate", args: [agent, ensNode, expiry], account: owner.account, chain: owner.walletClient.chain });
  await owner.publicClient.waitForTransactionReceipt({ hash: h1 });
  txs.push(h1);
  const h2 = await owner.walletClient.writeContract({ address: mandateContract, abi: EVM_MANDATE_ABI, functionName: "addPermission", args: [mandateId, permission.destination, permission.spendLimit, permission.perTxLimit], account: owner.account, chain: owner.walletClient.chain });
  await owner.publicClient.waitForTransactionReceipt({ hash: h2 });
  txs.push(h2);
  return { mandateId, txs };
}
