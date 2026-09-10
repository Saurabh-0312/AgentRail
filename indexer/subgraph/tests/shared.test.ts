import { BigInt, Bytes, ByteArray, crypto } from "@graphprotocol/graph-ts";
import { assert, describe, test } from "matchstick-as";

import { agentIdFromErc8004, base58Decode, isDigits, nodeForLabelHash, parseAllowed, targetBytes, uriType } from "../src/shared";
import { DATABOT_NODE } from "./helpers";

const RAIL_ALLOWED =
  '[{"chain":"solana:devnet","target":"6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a","perTx":"2000000","total":"5000000","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"},' +
  '{"chain":"hedera:testnet","target":"0.0.10440535","perTx":"30000","total":"50000","mint":"0.0.429274"},' +
  '{"chain":"eip155:84532","target":"0x301672eEf23F0e5f165cfba26762702F20A74430","perTx":"100","total":"500","mint":"0x036CbD53842c5426634e7929541eC2318f3dCF7e"}]';

describe("the join key", () => {
  test("namehash(databot.agentrail.eth) derived from LabelRegistered.labelHash equals the live node", () => {
    const labelHash = Bytes.fromByteArray(crypto.keccak256(ByteArray.fromUTF8("databot")));
    assert.bytesEquals(DATABOT_NODE, nodeForLabelHash(labelHash));
  });
});

describe("base58", () => {
  test("decodes a Solana pubkey to 32 bytes", () => {
    const shopAta = base58Decode("6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a")!;
    assert.i32Equals(32, shopAta.length);
    assert.stringEquals("0x57187b8d4b134bb647dc07b5cd75ec8326c7fc8ffe016673a486b89bed725ca5", shopAta.toHexString());
    const agent = base58Decode("4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV")!;
    assert.stringEquals("0x347fc638b52637118406e103813fbeb16ebfd7defcf7aa5c44f81db62f75465c", agent.toHexString());
  });

  test("leading 1s are leading zero bytes and an invalid character yields null", () => {
    assert.stringEquals("0x00000000", base58Decode("1111")!.toHexString());
    assert.assertTrue(base58Decode("0OIl") === null);
  });
});

describe("rail.allowed", () => {
  test("parses every entry with its chain, target and caps", () => {
    const entries = parseAllowed(RAIL_ALLOWED);
    assert.i32Equals(3, entries.length);
    assert.stringEquals("solana:devnet", entries[0].chain);
    assert.stringEquals("2000000", entries[0].perTx.toString());
    assert.stringEquals("5000000", entries[0].total.toString());
    assert.stringEquals("0.0.10440535", entries[1].target);
    assert.stringEquals("500", entries[2].total.toString());
    assert.stringEquals("0x036CbD53842c5426634e7929541eC2318f3dCF7e", entries[2].mint);
  });

  test("malformed input is an empty list, entries without chain or target are skipped", () => {
    assert.i32Equals(0, parseAllowed("not json").length);
    assert.i32Equals(0, parseAllowed('{"chain":"x"}').length);
    assert.i32Equals(1, parseAllowed('[{"chain":"eip155:1"},{"chain":"eip155:1","target":"0x00"}]').length);
    assert.stringEquals("0", parseAllowed('[{"chain":"eip155:1","target":"0x00","perTx":"lots"}]')[0].perTx.toString());
  });

  test("payee bytes: 20-byte address on EVM, 32-byte pubkey on Solana, UTF-8 account id on Hedera", () => {
    assert.i32Equals(20, targetBytes("eip155:84532", "0x301672eEf23F0e5f165cfba26762702F20A74430").length);
    assert.i32Equals(32, targetBytes("solana:devnet", "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a").length);
    assert.stringEquals("0.0.10440535", targetBytes("hedera:testnet", "0.0.10440535").toString());
  });
});

describe("small helpers", () => {
  test("rail.erc8004 -> Agent id", () => {
    assert.stringEquals("11155111:10190", agentIdFromErc8004("eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e:10190")!);
    assert.assertTrue(agentIdFromErc8004("solana:x:y:z") === null);
    assert.assertTrue(agentIdFromErc8004("eip155:1:0x00") === null);
  });

  test("agentURI classification and digit check", () => {
    assert.stringEquals("data", uriType("data:application/json;base64,e30="));
    assert.stringEquals("ipfs", uriType("ipfs://Qm"));
    assert.stringEquals("https", uriType("https://x"));
    assert.stringEquals("unknown", uriType("ens:x"));
    assert.assertTrue(isDigits("10000"));
    assert.assertTrue(!isDigits("10 USDC"));
    assert.assertTrue(!isDigits(""));
  });
});
