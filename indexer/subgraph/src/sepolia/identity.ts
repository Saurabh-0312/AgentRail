// ERC-8004 IdentityRegistry on Sepolia, in the Agent0 entity shape. Our mandate's agent is 10190;
// every agent registered from our start block is indexed the same way.
import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  MetadataSet as MetadataSetEvent,
  Registered as RegisteredEvent,
  Transfer as TransferEvent,
  URIUpdated as URIUpdatedEvent,
} from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, AgentMetadata } from "../../generated/schema";
import { uriType } from "../shared";

const CHAIN_ID = BigInt.fromI32(11155111);

function agentKey(agentId: BigInt): string {
  return CHAIN_ID.toString() + ":" + agentId.toString();
}

function loadOrCreate(agentId: BigInt, owner: Bytes, at: BigInt): Agent {
  let a = Agent.load(agentKey(agentId));
  if (a === null) {
    a = new Agent(agentKey(agentId));
    a.chainId = CHAIN_ID;
    a.agentId = agentId;
    a.owner = owner;
    a.operators = [];
    a.createdAt = at;
  }
  a.updatedAt = at;
  return a;
}

export function handleRegistered(event: RegisteredEvent): void {
  const a = loadOrCreate(event.params.agentId, event.params.owner, event.block.timestamp);
  a.owner = event.params.owner;
  a.agentURI = event.params.agentURI;
  a.agentURIType = uriType(event.params.agentURI);
  a.save();
}

export function handleMetadataSet(event: MetadataSetEvent): void {
  const a = loadOrCreate(event.params.agentId, event.transaction.from, event.block.timestamp);
  a.save();
  const id = a.id + ":" + event.params.metadataKey;
  let m = AgentMetadata.load(id);
  if (m === null) {
    m = new AgentMetadata(id);
    m.agent = a.id;
    m.key = event.params.metadataKey;
  }
  m.value = event.params.metadataValue;
  m.updatedAt = event.block.timestamp;
  m.save();
}

export function handleURIUpdated(event: URIUpdatedEvent): void {
  const a = loadOrCreate(event.params.agentId, event.params.updatedBy, event.block.timestamp);
  a.agentURI = event.params.newURI;
  a.agentURIType = uriType(event.params.newURI);
  a.save();
}

/** ERC-721 transfer of the identity: the mint precedes Registered in the same tx; later ones change the owner. */
export function handleTransfer(event: TransferEvent): void {
  const a = loadOrCreate(event.params.tokenId, event.params.to, event.block.timestamp);
  a.owner = event.params.to;
  a.save();
}
