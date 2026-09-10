// AgentRailRegistry on Sepolia: names are registered, issued as mandates, renewed, unregistered.
import { BigInt, Bytes, store } from "@graphprotocol/graph-ts";

import {
  ExpiryUpdated as ExpiryUpdatedEvent,
  LabelRegistered as LabelRegisteredEvent,
  LabelUnregistered as LabelUnregisteredEvent,
  MandateIssued as MandateIssuedEvent,
  ResolverUpdated as ResolverUpdatedEvent,
  TokenRegenerated as TokenRegeneratedEvent,
} from "../../generated/AgentRailRegistry/AgentRailRegistry";
import { Mandate, Name, Service, Token } from "../../generated/schema";
import { CHAIN_SEPOLIA, PARENT_NAME, mandateId, nodeForLabelHash, tokenKey } from "../shared";

/** Every registered label gets a Name (the node ↔ tokenId lookup) and, until issued, a Service row. */
export function handleLabelRegistered(event: LabelRegisteredEvent): void {
  const node = nodeForLabelHash(event.params.labelHash);
  const ensName = event.params.label + "." + PARENT_NAME;

  let name = Name.load(node.toHexString());
  if (name === null) {
    name = new Name(node.toHexString());
    name.isMandate = false;
    name.allowlistIds = [];
  }
  name.tokenId = event.params.tokenId;
  name.labelHash = event.params.labelHash;
  name.label = event.params.label;
  name.ensName = ensName;
  name.owner = event.params.owner;
  name.expiry = event.params.expiry;
  name.save();

  const token = new Token(tokenKey(event.params.tokenId));
  token.node = node;
  token.save();

  // Until MandateIssued says otherwise (same tx, later log), a name is a service listing.
  if (!name.isMandate) {
    let service = Service.load(node.toHexString());
    if (service === null) {
      service = new Service(node.toHexString());
      service.ensNode = node;
    }
    service.ensName = ensName;
    service.owner = event.params.owner;
    service.expiry = event.params.expiry;
    service.active = true;
    service.updatedAt = event.block.timestamp;
    service.save();
  } else {
    // re-registration of a mandate name: reactivate
    const m = Mandate.load(mandateId(node, CHAIN_SEPOLIA));
    if (m !== null) {
      m.agent = event.params.owner;
      m.expiry = event.params.expiry;
      m.active = true;
      m.updatedAt = event.block.timestamp;
      m.txHash = event.transaction.hash;
      m.save();
    }
  }
}

/** issueMandate(): the label names an agent. The Service row created a few logs earlier is retired. */
export function handleMandateIssued(event: MandateIssuedEvent): void {
  const token = Token.load(tokenKey(event.params.tokenId));
  if (token === null) return; // LabelRegistered always precedes MandateIssued in the same tx
  const node = token.node;
  const name = Name.load(node.toHexString());
  if (name === null) return;

  name.isMandate = true;
  name.save();
  store.remove("Service", node.toHexString());

  const id = mandateId(node, CHAIN_SEPOLIA);
  let m = Mandate.load(id);
  if (m === null) {
    m = new Mandate(id);
    m.ensNode = node;
    m.chain = CHAIN_SEPOLIA;
    m.createdAt = event.block.timestamp;
  }
  m.owner = event.transaction.from; // the registry owner issues; ROLE_REGISTRAR is proven by the tx landing
  m.agent = event.params.agent;
  m.ensName = event.params.label + "." + PARENT_NAME;
  m.expiry = event.params.expiry;
  m.active = true;
  m.updatedAt = event.block.timestamp;
  m.txHash = event.transaction.hash;
  m.save();
}

/** unregister(): the ENS kill switch. The mandate stays as history with active=false. */
export function handleLabelUnregistered(event: LabelUnregisteredEvent): void {
  const token = Token.load(tokenKey(event.params.tokenId));
  if (token === null) return;
  const name = Name.load(token.node.toHexString());
  if (name === null) return;
  if (name.isMandate) {
    const m = Mandate.load(mandateId(token.node, CHAIN_SEPOLIA));
    if (m !== null) {
      m.active = false;
      m.updatedAt = event.block.timestamp;
      m.save();
    }
  } else {
    const s = Service.load(token.node.toHexString());
    if (s !== null) {
      s.active = false;
      s.updatedAt = event.block.timestamp;
      s.save();
    }
  }
}

/** renew(): a new expiry on the same name. */
export function handleExpiryUpdated(event: ExpiryUpdatedEvent): void {
  const token = Token.load(tokenKey(event.params.tokenId));
  if (token === null) return;
  const name = Name.load(token.node.toHexString());
  if (name === null) return;
  name.expiry = event.params.newExpiry;
  name.save();
  if (name.isMandate) {
    const m = Mandate.load(mandateId(token.node, CHAIN_SEPOLIA));
    if (m !== null) {
      m.expiry = event.params.newExpiry;
      m.updatedAt = event.block.timestamp;
      m.save();
    }
  } else {
    const s = Service.load(token.node.toHexString());
    if (s !== null) {
      s.expiry = event.params.newExpiry;
      s.updatedAt = event.block.timestamp;
      s.save();
    }
  }
}

export function handleResolverUpdated(event: ResolverUpdatedEvent): void {
  const token = Token.load(tokenKey(event.params.tokenId));
  if (token === null) return;
  const name = Name.load(token.node.toHexString());
  if (name === null) return;
  name.resolver = event.params.resolver;
  name.save();
}

/** The registry may mint a fresh token id for a label; keep the lookup pointing at the node. */
export function handleTokenRegenerated(event: TokenRegeneratedEvent): void {
  const old = Token.load(tokenKey(event.params.oldTokenId));
  if (old === null) return;
  const fresh = new Token(tokenKey(event.params.newTokenId));
  fresh.node = old.node;
  fresh.save();
  const name = Name.load(old.node.toHexString());
  if (name !== null) {
    name.tokenId = event.params.newTokenId;
    name.save();
  }
}
