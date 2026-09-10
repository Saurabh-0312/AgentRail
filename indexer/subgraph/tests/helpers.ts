// Event builders for the matchstick suites. Parameter order follows each ABI exactly.
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as";

import {
  ExpiryUpdated,
  LabelRegistered,
  LabelUnregistered,
  MandateIssued,
  TokenRegenerated,
} from "../generated/AgentRailRegistry/AgentRailRegistry";
import { MetadataSet, Registered, Transfer, URIUpdated } from "../generated/IdentityRegistry/IdentityRegistry";
import { TextChanged } from "../generated/Resolver/Resolver";
import {
  MandateCreated,
  MandateRevoked,
  PaymentExecuted,
  PermissionAdded,
  PermissionRemoved,
  SpendAuthorized,
} from "../generated/EvmMandate/EvmMandate";

export const DEPLOYER = Address.fromString("0xAa4d6f945A57b972705712B5FbadE1Fd23521069");
export const AGENT_EVM = Address.fromString("0x6FB563E9Af8a1011f846842793d73bA12AA91875");
export const GRAPH_PAYEE = Address.fromString("0x301672eEf23F0e5f165cfba26762702F20A74430");
export const RESOLVER = Address.fromString("0xbfce4e394832c879fd2d95dae4F02259AFd23C16");
/** namehash("databot.agentrail.eth"): the live join key. */
export const DATABOT_NODE = Bytes.fromHexString("0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae");
export const MANDATE_ID = Bytes.fromHexString("0xcc38df0f414ff3c12c9e53ceeec58a39b442a47c695746f3882641ef6e91c8cc");

const u = (v: BigInt): ethereum.Value => ethereum.Value.fromUnsignedBigInt(v);
const s = (v: string): ethereum.Value => ethereum.Value.fromString(v);
const a = (v: Address): ethereum.Value => ethereum.Value.fromAddress(v);
const b32 = (v: Bytes): ethereum.Value => ethereum.Value.fromFixedBytes(v);
const bytes = (v: Bytes): ethereum.Value => ethereum.Value.fromBytes(v);

function withParams<T extends ethereum.Event>(params: ethereum.EventParam[], logIndex: i32 = 1): T {
  const e = changetype<T>(newMockEvent());
  e.parameters = params;
  e.logIndex = BigInt.fromI32(logIndex);
  return e;
}

const P = (name: string, v: ethereum.Value): ethereum.EventParam => new ethereum.EventParam(name, v);

// ---- AgentRailRegistry -------------------------------------------------------------------------

export function labelRegistered(tokenId: BigInt, labelHash: Bytes, label: string, owner: Address, expiry: BigInt, sender: Address, logIndex: i32 = 1): LabelRegistered {
  return withParams<LabelRegistered>([P("tokenId", u(tokenId)), P("labelHash", b32(labelHash)), P("label", s(label)), P("owner", a(owner)), P("expiry", u(expiry)), P("sender", a(sender))], logIndex);
}

export function mandateIssued(tokenId: BigInt, label: string, agent: Address, expiry: BigInt, resolver: Address, logIndex: i32 = 5): MandateIssued {
  return withParams<MandateIssued>([P("tokenId", u(tokenId)), P("label", s(label)), P("agent", a(agent)), P("expiry", u(expiry)), P("resolver", a(resolver))], logIndex);
}

export function labelUnregistered(tokenId: BigInt, sender: Address): LabelUnregistered {
  return withParams<LabelUnregistered>([P("tokenId", u(tokenId)), P("sender", a(sender))]);
}

export function expiryUpdated(tokenId: BigInt, newExpiry: BigInt, sender: Address): ExpiryUpdated {
  return withParams<ExpiryUpdated>([P("tokenId", u(tokenId)), P("newExpiry", u(newExpiry)), P("sender", a(sender))]);
}

export function tokenRegenerated(oldTokenId: BigInt, newTokenId: BigInt): TokenRegenerated {
  return withParams<TokenRegenerated>([P("oldTokenId", u(oldTokenId)), P("newTokenId", u(newTokenId))]);
}

// ---- Resolver -----------------------------------------------------------------------------------

export function textChanged(node: Bytes, key: string, value: string, logIndex: i32 = 1): TextChanged {
  return withParams<TextChanged>([P("node", b32(node)), P("indexedKey", bytes(Bytes.fromUTF8(key))), P("key", s(key)), P("value", s(value))], logIndex);
}

// ---- ERC-8004 IdentityRegistry --------------------------------------------------------------------

export function registered(agentId: BigInt, agentURI: string, owner: Address): Registered {
  return withParams<Registered>([P("agentId", u(agentId)), P("agentURI", s(agentURI)), P("owner", a(owner))]);
}

export function metadataSet(agentId: BigInt, key: string, value: Bytes): MetadataSet {
  return withParams<MetadataSet>([P("agentId", u(agentId)), P("indexedMetadataKey", bytes(Bytes.fromUTF8(key))), P("metadataKey", s(key)), P("metadataValue", bytes(value))]);
}

export function uriUpdated(agentId: BigInt, newURI: string, updatedBy: Address): URIUpdated {
  return withParams<URIUpdated>([P("agentId", u(agentId)), P("newURI", s(newURI)), P("updatedBy", a(updatedBy))]);
}

export function transfer(from: Address, to: Address, tokenId: BigInt): Transfer {
  return withParams<Transfer>([P("from", a(from)), P("to", a(to)), P("tokenId", u(tokenId))]);
}

// ---- EvmMandate (Base Sepolia) ---------------------------------------------------------------------

export function mandateCreated(mandateId: Bytes, owner: Address, agent: Address, ensNode: Bytes, expiry: BigInt): MandateCreated {
  return withParams<MandateCreated>([P("mandateId", b32(mandateId)), P("owner", a(owner)), P("agent", a(agent)), P("ensNode", b32(ensNode)), P("expiry", u(expiry))]);
}

export function permissionAdded(mandateId: Bytes, destination: Address, spendLimit: BigInt, perTxLimit: BigInt): PermissionAdded {
  return withParams<PermissionAdded>([P("mandateId", b32(mandateId)), P("destination", a(destination)), P("spendLimit", u(spendLimit)), P("perTxLimit", u(perTxLimit))]);
}

export function permissionRemoved(mandateId: Bytes, destination: Address): PermissionRemoved {
  return withParams<PermissionRemoved>([P("mandateId", b32(mandateId)), P("destination", a(destination))]);
}

export function mandateRevoked(mandateId: Bytes): MandateRevoked {
  return withParams<MandateRevoked>([P("mandateId", b32(mandateId))]);
}

export function spendAuthorized(mandateId: Bytes, destination: Address, amount: BigInt, spendTotal: BigInt, ref: Bytes, logIndex: i32): SpendAuthorized {
  return withParams<SpendAuthorized>([P("mandateId", b32(mandateId)), P("destination", a(destination)), P("amount", u(amount)), P("spendTotal", u(spendTotal)), P("ref", b32(ref))], logIndex);
}

export function paymentExecuted(mandateId: Bytes, destination: Address, token: Address, amount: BigInt, spendTotal: BigInt, logIndex: i32): PaymentExecuted {
  return withParams<PaymentExecuted>([P("mandateId", b32(mandateId)), P("destination", a(destination)), P("token", a(token)), P("amount", u(amount)), P("spendTotal", u(spendTotal))], logIndex);
}
