"use client";

import { EVM_MANDATE_ABI } from "@agentrail/sdk/src/evm/abi.ts";
import { readContract, waitForTransactionReceipt } from "@wagmi/core";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { namehash } from "viem/ens";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWriteContract } from "wagmi";

import { Button } from "@/components/ui/button";
import { ownerGate } from "@/lib/owner";

import { OwnerControls, type ActionResult, type CreateForm, type EvmChain, type MandateSummary } from "./owner-controls";
import { hederaTestnet, wagmiConfig } from "./wallet/provider";

const EVM_MANDATE: Address = "0x68822ce9109D9d71e99b07703cF6c851D0229AA9";
/** Literal ids, because wagmi types `chainId` as the union of the configured chains. */
const CHAIN_ID: Record<EvmChain, 84532 | typeof hederaTestnet.id> = { base: 84532, hedera: hederaTestnet.id };

function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  if (isConnected && address) {
    return (
      <Button variant="outline" size="sm" onClick={() => disconnect()}>
        <span className="mono">{address.slice(0, 6)}…{address.slice(-4)}</span> · disconnect
      </Button>
    );
  }
  const injected = connectors[0];
  return (
    <Button variant="outline" size="sm" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
      {isPending ? "connecting…" : "Connect wallet"}
    </Button>
  );
}

/**
 * The owner's two actions, wired to a browser wallet. The gate is the connected address matching
 * the owner; nothing is signed or shipped from this app, the wallet signs.
 */
export function OwnerActions({ owner, mandates, agentName }: { owner: string; mandates: Partial<Record<EvmChain, MandateSummary>>; agentName: string }) {
  const { address } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ActionResult[]>([]);
  const gate = ownerGate(address, owner);
  const push = (r: ActionResult) => setResults((rs) => [...rs, r]);

  const ensureChain = async (chain: EvmChain) => {
    await switchChainAsync({ chainId: CHAIN_ID[chain] });
  };

  const onRevoke = async (chain: EvmChain, mandateId: string) => {
    setBusy(true);
    try {
      await ensureChain(chain);
      const hash = await writeContractAsync({ address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "revokeMandate", args: [mandateId as Hex], chainId: CHAIN_ID[chain] });
      push({ kind: "revoke", chain, step: "revokeMandate sent", hash });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID[chain] });
      push({ kind: "revoke", chain, step: receipt.status === "success" ? "revoked" : "reverted", hash, done: receipt.status === "success", error: receipt.status === "success" ? undefined : "the transaction reverted" });
    } catch (e) {
      push({ kind: "revoke", chain, step: "failed", error: e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (form: CreateForm) => {
    setBusy(true);
    const chain = form.chain;
    try {
      await ensureChain(chain);
      const expiry = BigInt(Math.floor(Date.now() / 1000) + form.days * 86400);
      const node = namehash(form.ensName.trim().toLowerCase());
      const agent = form.agent.trim() as Address;
      const h1 = await writeContractAsync({ address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "createMandate", args: [agent, node, expiry], chainId: CHAIN_ID[chain] });
      push({ kind: "create", chain, step: "createMandate sent", hash: h1 });
      const r1 = await waitForTransactionReceipt(wagmiConfig, { hash: h1, chainId: CHAIN_ID[chain] });
      if (r1.status !== "success") throw new Error("createMandate reverted (a mandate for this agent may already exist; revoke it first)");
      const mandateId = await readContract(wagmiConfig, { address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "mandateIdFor", args: [owner as Address, agent], chainId: CHAIN_ID[chain] });
      const h2 = await writeContractAsync({ address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "addPermission", args: [mandateId, form.destination.trim() as Address, BigInt(form.total), BigInt(form.perTx)], chainId: CHAIN_ID[chain] });
      push({ kind: "create", chain, step: "addPermission sent", hash: h2 });
      const r2 = await waitForTransactionReceipt(wagmiConfig, { hash: h2, chainId: CHAIN_ID[chain] });
      push({ kind: "create", chain, step: r2.status === "success" ? `mandate ${mandateId.slice(0, 10)}… issued with one permission` : "addPermission reverted", hash: h2, done: r2.status === "success" });
    } catch (e) {
      push({ kind: "create", chain, step: "failed", error: e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return <OwnerControls gate={gate} owner={owner} mandates={mandates} defaultEnsName={agentName} onRevoke={onRevoke} onCreate={onCreate} busy={busy} results={results} connect={<ConnectButton />} />;
}
