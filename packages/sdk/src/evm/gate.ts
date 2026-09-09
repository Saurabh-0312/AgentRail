/**
 * The EVM gate: `EvmMandate.check` (a free view) then `EvmMandate.authorize` (the recorded spend).
 * Both happen before any payment is signed. If `check` names an error, nothing else is touched.
 */
import type { Address, Hex } from "viem";

import { MandateRefused } from "../errors.ts";
import { EVM_MANDATE_ABI, EVM_MANDATE_ERRORS, NO_ERROR } from "./abi.ts";

/** The two viem calls the gate needs. Injected so tests can fake the chain. */
export interface EvmGateClient {
  readContract(args: { address: Address; abi: typeof EVM_MANDATE_ABI; functionName: "check"; args: readonly [Hex, Address, Address, bigint] }): Promise<Hex>;
  writeContract(args: { address: Address; abi: typeof EVM_MANDATE_ABI; functionName: "authorize"; args: readonly [Hex, Address, bigint, Hex] }): Promise<Hex>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted" }>;
}

export interface EvmGateConfig {
  chain: string;
  mandateContract: Address;
  agent: Address;
  client: EvmGateClient;
}

export async function evmGate(
  cfg: EvmGateConfig,
  mandateId: Hex,
  destination: Address,
  amount: bigint,
  ref: Hex,
): Promise<Hex> {
  const selector = await cfg.client.readContract({
    address: cfg.mandateContract,
    abi: EVM_MANDATE_ABI,
    functionName: "check",
    args: [mandateId, cfg.agent, destination, amount],
  });
  if (selector !== NO_ERROR) {
    throw new MandateRefused(cfg.chain, EVM_MANDATE_ERRORS[selector] ?? selector, { selector });
  }
  const hash = await cfg.client.writeContract({
    address: cfg.mandateContract,
    abi: EVM_MANDATE_ABI,
    functionName: "authorize",
    args: [mandateId, destination, amount, ref],
  });
  const receipt = await cfg.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new MandateRefused(cfg.chain, "authorize reverted", { hash });
  }
  return hash;
}
