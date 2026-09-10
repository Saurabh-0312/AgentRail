// EvmMandate on Base Sepolia. Every event carries mandateId; only MandateCreated carries ensNode, so
// the first handler records the mandateId -> ensNode lookup the others need.
//
// Refusals never reach here: EvmMandate.check is a view the SDK consults first, and a refusal is not
// a transaction. Every Action from this source is allowed=true by construction (EVENTS.md).
import { BigInt, Bytes, ethereum, store } from "@graphprotocol/graph-ts";

import {
  MandateCreated as MandateCreatedEvent,
  MandateRevoked as MandateRevokedEvent,
  PaymentExecuted as PaymentExecutedEvent,
  PermissionAdded as PermissionAddedEvent,
  PermissionRemoved as PermissionRemovedEvent,
  SpendAuthorized as SpendAuthorizedEvent,
} from "../../generated/EvmMandate/EvmMandate";
import { Action, Mandate, MandateKey, Permission } from "../../generated/schema";
import { CHAIN_BASE, mandateId } from "../shared";

export function permissionId(node: Bytes, destination: Bytes): string {
  return mandateId(node, CHAIN_BASE) + ":" + destination.toHexString();
}

export function actionId(txHash: Bytes, logIndex: BigInt): string {
  return txHash.toHexString() + ":" + logIndex.toString();
}

export function handleMandateCreated(event: MandateCreatedEvent): void {
  const key = new MandateKey(event.params.mandateId.toHexString());
  key.node = event.params.ensNode;
  key.agent = event.params.agent;
  key.save();

  const id = mandateId(event.params.ensNode, CHAIN_BASE);
  let m = Mandate.load(id);
  if (m === null) {
    m = new Mandate(id);
    m.ensNode = event.params.ensNode;
    m.chain = CHAIN_BASE;
    m.createdAt = event.block.timestamp;
  }
  m.owner = event.params.owner;
  m.agent = event.params.agent;
  m.expiry = event.params.expiry;
  m.active = true;
  m.updatedAt = event.block.timestamp;
  m.txHash = event.transaction.hash;
  m.save();
}

export function handlePermissionAdded(event: PermissionAddedEvent): void {
  const key = MandateKey.load(event.params.mandateId.toHexString());
  if (key === null) return;
  const id = permissionId(key.node, event.params.destination);
  let p = Permission.load(id);
  if (p === null) {
    p = new Permission(id);
    p.mandate = mandateId(key.node, CHAIN_BASE);
    p.target = event.params.destination;
    p.instructions = [];
    p.source = "onchain";
    p.targetChain = "eip155:84532";
  }
  p.totalLimit = event.params.spendLimit;
  p.perTxLimit = event.params.perTxLimit;
  p.spentTotal = BigInt.zero(); // a fresh permission starts at zero; the contract resets it too
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handlePermissionRemoved(event: PermissionRemovedEvent): void {
  const key = MandateKey.load(event.params.mandateId.toHexString());
  if (key === null) return;
  store.remove("Permission", permissionId(key.node, event.params.destination));
}

export function handleMandateRevoked(event: MandateRevokedEvent): void {
  const key = MandateKey.load(event.params.mandateId.toHexString());
  if (key === null) return;
  const m = Mandate.load(mandateId(key.node, CHAIN_BASE));
  if (m === null) return;
  m.active = false;
  m.updatedAt = event.block.timestamp;
  m.save();
}

function recordSpend(
  mandateIdHex: string,
  destination: Bytes,
  amount: BigInt,
  spendTotal: BigInt,
  kind: string,
  ref: Bytes | null,
  event: ethereum.Event,
): void {
  const key = MandateKey.load(mandateIdHex);
  if (key === null) return;
  const mid = mandateId(key.node, CHAIN_BASE);

  const a = new Action(actionId(event.transaction.hash, event.logIndex));
  a.mandate = mid;
  a.chain = CHAIN_BASE;
  a.timestamp = event.block.timestamp;
  a.target = destination;
  a.amount = amount;
  a.allowed = true;
  a.blockReason = null;
  a.txHash = event.transaction.hash;
  a.kind = kind;
  a.ref = ref;
  a.agent = key.agent;
  a.save();

  const p = Permission.load(permissionId(key.node, destination));
  if (p !== null) {
    p.spentTotal = spendTotal;
    p.updatedAt = event.block.timestamp;
    p.save();
  }
  const m = Mandate.load(mid);
  if (m !== null) {
    m.updatedAt = event.block.timestamp;
    m.save();
  }
}

/** The gate passed and recorded the spend before the x402 settlement (README "Limitations"). */
export function handleSpendAuthorized(event: SpendAuthorizedEvent): void {
  recordSpend(event.params.mandateId.toHexString(), event.params.destination, event.params.amount, event.params.spendTotal, "authorize", event.params.ref, event);
}

/** The contract pulled the ERC-20 allowance itself. */
export function handlePaymentExecuted(event: PaymentExecutedEvent): void {
  recordSpend(event.params.mandateId.toHexString(), event.params.destination, event.params.amount, event.params.spendTotal, "payment", null, event);
}
