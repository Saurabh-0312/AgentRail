"use client";

import { EVM_MANDATE_ABI } from "@agentrail/sdk/src/evm/abi.ts";
import { readContract, waitForTransactionReceipt } from "@wagmi/core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { erc20Abi, type Address, type Hex } from "viem";
import { namehash } from "viem/ens";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWriteContract } from "wagmi";

import { Button } from "@/components/ui/button";
import { stepSatisfied } from "@/lib/delegation";
import { ownerGate } from "@/lib/owner";

import { OwnerControls, type ActionResult, type CreateForm, type CreateProgress, type EvmChain, type MandateSummary } from "./owner-controls";
import { hederaTestnet, wagmiConfig } from "./wallet/provider";

const EVM_MANDATE: Address = "0x68822ce9109D9d71e99b07703cF6c851D0229AA9";
/** Literal ids, because wagmi types `chainId` as the union of the configured chains. */
const CHAIN_ID: Record<EvmChain, 84532 | typeof hederaTestnet.id> = { base: 84532, hedera: hederaTestnet.id };
/**
 * Explicit gas limits, as the SDK's owner helper uses: a wallet that estimates against a node
 * still catching up (Hedera's relay, a load-balanced public RPC one block behind) would simulate
 * `addPermission` against a mandate it cannot see yet and refuse to sign. The HTS facade needs far
 * more gas than an ERC-20 for the same `approve`.
 */
const GAS: Record<EvmChain, { mandate: bigint; approve: bigint }> = { base: { mandate: 400_000n, approve: 200_000n }, hedera: { mandate: 400_000n, approve: 1_000_000n } };

function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  if (isConnected && address) {
    return (
      <Button variant="outline" size="sm" onClick={() => disconnect()} data-testid="disconnect">
        <span className="mono">{address.slice(0, 6)}…{address.slice(-4)}</span> · disconnect
      </Button>
    );
  }
  const injected = connectors[0];
  return (
    <Button variant="outline" size="sm" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })} data-testid="connect">
      {isPending ? "connecting…" : "Connect wallet"}
    </Button>
  );
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e));

/**
 * The owner's actions, wired to a browser wallet. The gate is the connected address matching the
 * owner; nothing is signed or shipped from this app, the wallet signs. Creating an agent is three
 * signatures: the mandate, its permission, and the token approval that lets the contract pull.
 */
export function OwnerActions({ owner, mandates, agentName }: { owner: string; mandates: Partial<Record<EvmChain, MandateSummary>>; agentName: string }) {
  const router = useRouter();
  const { address } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ActionResult[]>([]);
  const [progress, setProgress] = useState<CreateProgress>({});
  const gate = ownerGate(address, owner);
  const push = (r: ActionResult) => setResults((rs) => [...rs, r]);
  const step = (n: 1 | 2 | 3, p: CreateProgress[1]) => setProgress((s) => ({ ...s, [n]: p }));

  const ensureChain = async (chain: EvmChain) => {
    await switchChainAsync({ chainId: CHAIN_ID[chain] });
  };

  const approve = async (chain: EvmChain, token: Address, amount: bigint) => {
    const hash = await writeContractAsync({ address: token, abi: erc20Abi, functionName: "approve", args: [EVM_MANDATE, amount], chainId: CHAIN_ID[chain], gas: GAS[chain].approve });
    push({ kind: "delegate", chain, step: "approve sent", hash });
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID[chain] });
    if (receipt.status !== "success") throw new Error("approve reverted");
    return hash;
  };

  const onRevoke = async (chain: EvmChain, mandateId: string) => {
    setBusy(true);
    try {
      await ensureChain(chain);
      const hash = await writeContractAsync({ address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "revokeMandate", args: [mandateId as Hex], chainId: CHAIN_ID[chain], gas: GAS[chain].mandate });
      push({ kind: "revoke", chain, step: "revokeMandate sent", hash });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID[chain] });
      push({ kind: "revoke", chain, step: receipt.status === "success" ? "revoked" : "reverted", hash, done: receipt.status === "success", error: receipt.status === "success" ? undefined : "the transaction reverted" });
      router.refresh();
    } catch (e) {
      push({ kind: "revoke", chain, step: "failed", error: firstLine(e) });
    } finally {
      setBusy(false);
    }
  };

  const onDelegate = async (chain: EvmChain, token: string, amount: string) => {
    setBusy(true);
    try {
      await ensureChain(chain);
      const hash = await approve(chain, token as Address, BigInt(amount));
      push({ kind: "delegate", chain, step: "allowance set", hash, done: true });
      router.refresh();
    } catch (e) {
      push({ kind: "delegate", chain, step: "failed", error: firstLine(e) });
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (form: CreateForm) => {
    setBusy(true);
    setProgress({});
    const chain = form.chain;
    try {
      await ensureChain(chain);
      const expiry = BigInt(Math.floor(Date.now() / 1000) + form.days * 86400);
      const node = namehash(form.ensName.trim().toLowerCase());
      const agent = form.agent.trim() as Address;
      const token = form.token.trim() as Address;
      const approveAmount = BigInt(form.approveAmount.trim());

      // 1 of 3: the mandate
      step(1, { state: "pending" });
      const h1 = await writeContractAsync({ address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "createMandate", args: [agent, node, expiry], chainId: CHAIN_ID[chain], gas: GAS[chain].mandate });
      step(1, { state: "pending", hash: h1 });
      push({ kind: "create", chain, step: "createMandate sent", hash: h1 });
      const r1 = await waitForTransactionReceipt(wagmiConfig, { hash: h1, chainId: CHAIN_ID[chain] });
      if (r1.status !== "success") {
        step(1, { state: "failed", hash: h1, note: "reverted" });
        throw new Error("createMandate reverted (a mandate for this agent may already exist; revoke it first)");
      }
      step(1, { state: "confirmed", hash: h1 });

      // 2 of 3: the permission
      step(2, { state: "pending" });
      const mandateId = await readContract(wagmiConfig, { address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "mandateIdFor", args: [owner as Address, agent], chainId: CHAIN_ID[chain] });
      const h2 = await writeContractAsync({ address: EVM_MANDATE, abi: EVM_MANDATE_ABI, functionName: "addPermission", args: [mandateId, form.destination.trim() as Address, BigInt(form.total), BigInt(form.perTx)], chainId: CHAIN_ID[chain], gas: GAS[chain].mandate });
      step(2, { state: "pending", hash: h2 });
      push({ kind: "create", chain, step: "addPermission sent", hash: h2 });
      const r2 = await waitForTransactionReceipt(wagmiConfig, { hash: h2, chainId: CHAIN_ID[chain] });
      if (r2.status !== "success") {
        step(2, { state: "failed", hash: h2, note: "reverted" });
        throw new Error("addPermission reverted");
      }
      step(2, { state: "confirmed", hash: h2, note: `mandate ${mandateId.slice(0, 10)}…` });

      // 3 of 3: the delegation, skipped when the standing allowance already covers it
      step(3, { state: "pending", note: "reading the current allowance…" });
      const allowance = await readContract(wagmiConfig, { address: token, abi: erc20Abi, functionName: "allowance", args: [owner as Address, EVM_MANDATE], chainId: CHAIN_ID[chain] });
      if (stepSatisfied(allowance.toString(), approveAmount.toString())) {
        step(3, { state: "satisfied", note: `the current allowance (${allowance.toString()} base units) already covers ${approveAmount.toString()}` });
        push({ kind: "create", chain, step: `mandate ${mandateId.slice(0, 10)}… issued; allowance already covers the cap`, done: true });
      } else {
        const h3 = await approve(chain, token, approveAmount);
        step(3, { state: "confirmed", hash: h3, note: `allowance set to ${approveAmount.toString()} base units` });
        push({ kind: "create", chain, step: `mandate ${mandateId.slice(0, 10)}… issued, permitted and funded`, hash: h3, done: true });
      }
      router.refresh();
    } catch (e) {
      const msg = firstLine(e);
      setProgress((s) => {
        const next = { ...s };
        for (const n of [1, 2, 3] as const) if (next[n]?.state === "pending") next[n] = { ...next[n]!, state: "failed", note: msg };
        return next;
      });
      push({ kind: "create", chain, step: "failed", error: msg });
    } finally {
      setBusy(false);
    }
  };

  return <OwnerControls gate={gate} owner={owner} mandates={mandates} defaultEnsName={agentName} onRevoke={onRevoke} onCreate={onCreate} onDelegate={onDelegate} busy={busy} results={results} progress={progress} connect={<ConnectButton />} />;
}
