import { Address, BigInt, Bytes, ByteArray, crypto } from "@graphprotocol/graph-ts";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as";

import { handleMetadataSet, handleRegistered, handleTransfer, handleURIUpdated } from "../src/sepolia/identity";
import {
  handleExpiryUpdated,
  handleLabelRegistered,
  handleLabelUnregistered,
  handleMandateIssued,
  handleTokenRegenerated,
} from "../src/sepolia/registry";
import { handleTextChanged } from "../src/sepolia/resolver";
import { nodeForLabelHash } from "../src/shared";
import {
  AGENT_EVM,
  DATABOT_NODE,
  DEPLOYER,
  RESOLVER,
  expiryUpdated,
  labelRegistered,
  labelUnregistered,
  mandateIssued,
  metadataSet,
  registered,
  textChanged,
  tokenRegenerated,
  transfer,
  uriUpdated,
} from "./helpers";

const labelHash = (label: string): Bytes => Bytes.fromByteArray(crypto.keccak256(ByteArray.fromUTF8(label)));
const TOKEN_DATABOT = BigInt.fromString("1000");
const TOKEN_FEED = BigInt.fromString("2000");
const EXPIRY = BigInt.fromString("1820509272");
const MANDATE = DATABOT_NODE.toHexString() + ":sepolia";
const FEED_NODE = nodeForLabelHash(labelHash("feed"));

function issueDatabot(): void {
  handleLabelRegistered(labelRegistered(TOKEN_DATABOT, labelHash("databot"), "databot", AGENT_EVM, EXPIRY, DEPLOYER, 1));
  handleMandateIssued(mandateIssued(TOKEN_DATABOT, "databot", AGENT_EVM, EXPIRY, RESOLVER, 5));
}

describe("AgentRailRegistry", () => {
  beforeEach(() => {
    clearStore();
  });

  test("issueMandate: LabelRegistered then MandateIssued in one tx becomes a Mandate keyed by the live ensNode", () => {
    issueDatabot();
    assert.entityCount("Mandate", 1);
    assert.fieldEquals("Mandate", MANDATE, "ensNode", DATABOT_NODE.toHexString());
    assert.fieldEquals("Mandate", MANDATE, "chain", "sepolia");
    assert.fieldEquals("Mandate", MANDATE, "agent", AGENT_EVM.toHexString());
    assert.fieldEquals("Mandate", MANDATE, "ensName", "databot.agentrail.eth");
    assert.fieldEquals("Mandate", MANDATE, "expiry", EXPIRY.toString());
    assert.fieldEquals("Mandate", MANDATE, "active", "true");
    // the provisional Service row was retired, the lookups exist
    assert.notInStore("Service", DATABOT_NODE.toHexString());
    assert.fieldEquals("Name", DATABOT_NODE.toHexString(), "isMandate", "true");
    assert.fieldEquals("Token", TOKEN_DATABOT.toString(), "node", DATABOT_NODE.toHexString());
  });

  test("a plain register() is a Service, not a Mandate", () => {
    handleLabelRegistered(labelRegistered(TOKEN_FEED, labelHash("feed"), "feed", DEPLOYER, EXPIRY, DEPLOYER));
    assert.entityCount("Mandate", 0);
    assert.fieldEquals("Service", FEED_NODE.toHexString(), "ensName", "feed.agentrail.eth");
    assert.fieldEquals("Service", FEED_NODE.toHexString(), "active", "true");
    assert.fieldEquals("Service", FEED_NODE.toHexString(), "owner", DEPLOYER.toHexString());
  });

  test("unregister is the ENS kill switch: the mandate stays as history with active=false", () => {
    issueDatabot();
    handleLabelUnregistered(labelUnregistered(TOKEN_DATABOT, DEPLOYER));
    assert.fieldEquals("Mandate", MANDATE, "active", "false");
    assert.entityCount("Mandate", 1);
  });

  test("renew updates expiry; a regenerated token id keeps pointing at the same node", () => {
    issueDatabot();
    handleExpiryUpdated(expiryUpdated(TOKEN_DATABOT, BigInt.fromString("1900000000"), DEPLOYER));
    assert.fieldEquals("Mandate", MANDATE, "expiry", "1900000000");
    handleTokenRegenerated(tokenRegenerated(TOKEN_DATABOT, BigInt.fromString("1001")));
    handleExpiryUpdated(expiryUpdated(BigInt.fromString("1001"), BigInt.fromString("1950000000"), DEPLOYER));
    assert.fieldEquals("Mandate", MANDATE, "expiry", "1950000000");
  });

  test("events for a token this registry never registered are ignored", () => {
    handleLabelUnregistered(labelUnregistered(BigInt.fromString("999"), DEPLOYER));
    handleMandateIssued(mandateIssued(BigInt.fromString("999"), "ghost", AGENT_EVM, EXPIRY, RESOLVER));
    assert.entityCount("Mandate", 0);
    assert.entityCount("Service", 0);
  });
});

describe("Resolver text records", () => {
  beforeEach(() => {
    clearStore();
    issueDatabot();
    handleLabelRegistered(labelRegistered(TOKEN_FEED, labelHash("feed"), "feed", DEPLOYER, EXPIRY, DEPLOYER));
  });

  test("rail.* on the mandate node become MandateRecord rows", () => {
    handleTextChanged(textChanged(DATABOT_NODE, "rail.agent.solana", "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV"));
    handleTextChanged(textChanged(DATABOT_NODE, "rail.status", "idle"));
    assert.entityCount("MandateRecord", 2);
    assert.fieldEquals("MandateRecord", MANDATE + ":rail.agent.solana", "value", "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV");
    assert.fieldEquals("MandateRecord", MANDATE + ":rail.status", "mandate", MANDATE);
  });

  test("rail.allowed becomes one Permission per payee, with the payee bytes in each chain's form", () => {
    const raw =
      '[{"chain":"solana:devnet","target":"6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a","perTx":"2000000","total":"5000000"},' +
      '{"chain":"hedera:testnet","target":"0.0.10440535","perTx":"30000","total":"50000"},' +
      '{"chain":"eip155:84532","target":"0x301672eEf23F0e5f165cfba26762702F20A74430","perTx":"100","total":"500"}]';
    handleTextChanged(textChanged(DATABOT_NODE, "rail.allowed", raw));
    assert.entityCount("Permission", 3);
    const sol = DATABOT_NODE.toHexString() + ":sepolia:allowlist:solana:devnet:6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";
    assert.fieldEquals("Permission", sol, "target", "0x57187b8d4b134bb647dc07b5cd75ec8326c7fc8ffe016673a486b89bed725ca5");
    assert.fieldEquals("Permission", sol, "perTxLimit", "2000000");
    assert.fieldEquals("Permission", sol, "totalLimit", "5000000");
    assert.fieldEquals("Permission", sol, "source", "allowlist");
    assert.fieldEquals("Permission", sol, "mandate", MANDATE);
    const base = DATABOT_NODE.toHexString() + ":sepolia:allowlist:eip155:84532:0x301672eEf23F0e5f165cfba26762702F20A74430";
    assert.fieldEquals("Permission", base, "target", "0x301672eef23f0e5f165cfba26762702f20a74430");
    assert.fieldEquals("Permission", base, "totalLimit", "500");
    const hedera = DATABOT_NODE.toHexString() + ":sepolia:allowlist:hedera:testnet:0.0.10440535";
    assert.fieldEquals("Permission", hedera, "target", Bytes.fromUTF8("0.0.10440535").toHexString());
  });

  test("a rewritten rail.allowed replaces the previous rows instead of accumulating them", () => {
    handleTextChanged(textChanged(DATABOT_NODE, "rail.allowed", '[{"chain":"eip155:84532","target":"0x301672eEf23F0e5f165cfba26762702F20A74430","perTx":"100","total":"150"}]', 1));
    handleTextChanged(textChanged(DATABOT_NODE, "rail.allowed", '[{"chain":"hedera:testnet","target":"0.0.10440535","perTx":"30000","total":"50000"}]', 2));
    assert.entityCount("Permission", 1);
    assert.notInStore("Permission", DATABOT_NODE.toHexString() + ":sepolia:allowlist:eip155:84532:0x301672eEf23F0e5f165cfba26762702F20A74430");
  });

  test("rail.erc8004 links the Mandate to its ERC-8004 Agent id", () => {
    handleTextChanged(textChanged(DATABOT_NODE, "rail.erc8004", "eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e:10190"));
    assert.fieldEquals("Mandate", MANDATE, "agentIdentity", "11155111:10190");
  });

  test("discovery records on a service node fill the Service row", () => {
    handleTextChanged(textChanged(FEED_NODE, "rail.endpoint", "https://agentrail-data-feed.onrender.com", 1));
    handleTextChanged(textChanged(FEED_NODE, "rail.chain", "hedera:testnet", 2));
    handleTextChanged(textChanged(FEED_NODE, "rail.price", "10000", 3));
    handleTextChanged(textChanged(FEED_NODE, "rail.token", "0.0.429274", 4));
    handleTextChanged(textChanged(FEED_NODE, "rail.scheme", "x402", 5));
    handleTextChanged(textChanged(FEED_NODE, "description", "spot prices", 6));
    const id = FEED_NODE.toHexString();
    assert.fieldEquals("Service", id, "endpoint", "https://agentrail-data-feed.onrender.com");
    assert.fieldEquals("Service", id, "chain", "hedera:testnet");
    assert.fieldEquals("Service", id, "price", "10000");
    assert.fieldEquals("Service", id, "token", "0.0.429274");
    assert.fieldEquals("Service", id, "scheme", "x402");
    assert.fieldEquals("Service", id, "description", "spot prices");
    assert.entityCount("MandateRecord", 0);
  });

  test("a record on a node this registry does not own is ignored", () => {
    handleTextChanged(textChanged(Bytes.fromHexString("0x" + "ab".repeat(32)), "rail.endpoint", "https://elsewhere"));
    assert.entityCount("Service", 1);
    assert.entityCount("MandateRecord", 0);
  });
});

describe("ERC-8004 IdentityRegistry (Agent0 shape)", () => {
  beforeEach(() => {
    clearStore();
  });

  test("mint Transfer then Registered in one tx yields one Agent with the Agent0 id and uri type", () => {
    const id = BigInt.fromString("10190");
    handleTransfer(transfer(Address.zero(), AGENT_EVM, id));
    handleRegistered(registered(id, "data:application/json;base64,e30=", AGENT_EVM));
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", "11155111:10190", "chainId", "11155111");
    assert.fieldEquals("Agent", "11155111:10190", "agentId", "10190");
    assert.fieldEquals("Agent", "11155111:10190", "owner", AGENT_EVM.toHexString());
    assert.fieldEquals("Agent", "11155111:10190", "agentURIType", "data");
  });

  test("metadata, uri updates and ownership transfers", () => {
    const id = BigInt.fromString("10190");
    handleRegistered(registered(id, "ipfs://Qm", AGENT_EVM));
    handleMetadataSet(metadataSet(id, "agentWallet", Bytes.fromHexString("0x1234")));
    assert.fieldEquals("AgentMetadata", "11155111:10190:agentWallet", "value", "0x1234");
    assert.fieldEquals("AgentMetadata", "11155111:10190:agentWallet", "agent", "11155111:10190");
    handleURIUpdated(uriUpdated(id, "https://agent.example/registration.json", AGENT_EVM));
    assert.fieldEquals("Agent", "11155111:10190", "agentURIType", "https");
    handleTransfer(transfer(AGENT_EVM, DEPLOYER, id));
    assert.fieldEquals("Agent", "11155111:10190", "owner", DEPLOYER.toHexString());
    assert.entityCount("Agent", 1);
  });
});
