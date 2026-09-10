// The resolver behind agentrail.eth names. Every rail.* text record lands here.
//
//   mandate node  ->  MandateRecord rows; rail.allowed becomes Permission rows (source "allowlist");
//                     rail.erc8004 links the Mandate to its ERC-8004 Agent
//   service node  ->  the five discovery fields on the Service row
//   any other node -> ignored (this resolver is shared ENSv2 infrastructure)
import { BigInt, Bytes, store } from "@graphprotocol/graph-ts";

import { TextChanged as TextChangedEvent } from "../../generated/Resolver/Resolver";
import { Mandate, MandateRecord, Name, Permission, Service } from "../../generated/schema";
import { CHAIN_SEPOLIA, agentIdFromErc8004, allowlistPermissionId, isDigits, mandateId, parseAllowed, targetBytes } from "../shared";

export function handleTextChanged(event: TextChangedEvent): void {
  const node = event.params.node;
  const key = event.params.key;
  const value = event.params.value;
  const name = Name.load(node.toHexString());
  if (name === null) return; // not one of ours

  if (name.isMandate) {
    const mid = mandateId(node, CHAIN_SEPOLIA);
    const mandate = Mandate.load(mid);
    if (mandate === null) return;

    let rec = MandateRecord.load(mid + ":" + key);
    if (rec === null) {
      rec = new MandateRecord(mid + ":" + key);
      rec.mandate = mid;
      rec.key = key;
    }
    rec.value = value;
    rec.updatedAt = event.block.timestamp;
    rec.txHash = event.transaction.hash;
    rec.save();

    if (key == "rail.allowed") {
      replaceAllowlist(name, mandate, node, value, event.block.timestamp);
    } else if (key == "rail.erc8004") {
      mandate.agentIdentity = agentIdFromErc8004(value);
    }
    mandate.updatedAt = event.block.timestamp;
    mandate.save();
    return;
  }

  // a service name: the discovery records
  let service = Service.load(node.toHexString());
  if (service === null) {
    service = new Service(node.toHexString());
    service.ensNode = node;
    service.ensName = name.ensName;
    service.owner = name.owner;
    service.expiry = name.expiry;
    service.active = true;
  }
  if (key == "rail.endpoint") service.endpoint = value;
  else if (key == "rail.chain") service.chain = value;
  else if (key == "rail.price") service.price = isDigits(value) ? BigInt.fromString(value) : null;
  else if (key == "rail.token") service.token = value;
  else if (key == "rail.scheme") service.scheme = value;
  else if (key == "description") service.description = value;
  service.updatedAt = event.block.timestamp;
  service.save();
}

/** rail.allowed is rewritten whole; so is its mirror. One Permission per payee. */
function replaceAllowlist(name: Name, mandate: Mandate, node: Bytes, raw: string, now: BigInt): void {
  const old = name.allowlistIds;
  for (let i = 0; i < old.length; i++) store.remove("Permission", old[i]);

  const entries = parseAllowed(raw);
  const ids = new Array<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const id = allowlistPermissionId(node, e.chain, e.target);
    const p = new Permission(id);
    p.mandate = mandate.id;
    p.target = targetBytes(e.chain, e.target);
    p.instructions = [];
    p.perTxLimit = e.perTx;
    p.totalLimit = e.total;
    p.spentTotal = BigInt.zero(); // the allow-list is a ceiling; spend is enforced and counted on chain
    p.source = "allowlist";
    p.targetChain = e.chain;
    p.updatedAt = now;
    p.save();
    ids.push(id);
  }
  name.allowlistIds = ids;
  name.save();
}
