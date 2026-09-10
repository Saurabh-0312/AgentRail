import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as";

import {
  handleMandateCreated,
  handleMandateRevoked,
  handlePaymentExecuted,
  handlePermissionAdded,
  handlePermissionRemoved,
  handleSpendAuthorized,
} from "../src/base/mandate";
import {
  AGENT_EVM,
  DATABOT_NODE,
  DEPLOYER,
  GRAPH_PAYEE,
  MANDATE_ID,
  mandateCreated,
  mandateRevoked,
  paymentExecuted,
  permissionAdded,
  permissionRemoved,
  spendAuthorized,
} from "./helpers";

const MANDATE = DATABOT_NODE.toHexString() + ":base";
const PERMISSION = MANDATE + ":" + GRAPH_PAYEE.toHexString();
const EXPIRY = BigInt.fromString("1791570000");
const REF = Bytes.fromHexString("0x" + "11".repeat(32));
const USDC = Address.fromString("0x036CbD53842c5426634e7929541eC2318f3dCF7e");

function issue(): void {
  handleMandateCreated(mandateCreated(MANDATE_ID, DEPLOYER, AGENT_EVM, DATABOT_NODE, EXPIRY));
  handlePermissionAdded(permissionAdded(MANDATE_ID, GRAPH_PAYEE, BigInt.fromString("500"), BigInt.fromString("100")));
}

describe("EvmMandate on Base Sepolia", () => {
  beforeEach(() => {
    clearStore();
  });

  test("MandateCreated joins on ensNode: the Mandate id is the same node with chain base", () => {
    issue();
    assert.entityCount("Mandate", 1);
    assert.fieldEquals("Mandate", MANDATE, "ensNode", DATABOT_NODE.toHexString());
    assert.fieldEquals("Mandate", MANDATE, "chain", "base");
    assert.fieldEquals("Mandate", MANDATE, "owner", DEPLOYER.toHexString());
    assert.fieldEquals("Mandate", MANDATE, "agent", AGENT_EVM.toHexString());
    assert.fieldEquals("Mandate", MANDATE, "expiry", EXPIRY.toString());
    assert.fieldEquals("Mandate", MANDATE, "active", "true");
    assert.fieldEquals("MandateKey", MANDATE_ID.toHexString(), "node", DATABOT_NODE.toHexString());
  });

  test("PermissionAdded records the caps with zero spent", () => {
    issue();
    assert.entityCount("Permission", 1);
    assert.fieldEquals("Permission", PERMISSION, "target", GRAPH_PAYEE.toHexString());
    assert.fieldEquals("Permission", PERMISSION, "perTxLimit", "100");
    assert.fieldEquals("Permission", PERMISSION, "totalLimit", "500");
    assert.fieldEquals("Permission", PERMISSION, "spentTotal", "0");
    assert.fieldEquals("Permission", PERMISSION, "source", "onchain");
    assert.fieldEquals("Permission", PERMISSION, "mandate", MANDATE);
  });

  test("every SpendAuthorized is an allowed Action and moves spentTotal", () => {
    issue();
    const a1 = spendAuthorized(MANDATE_ID, GRAPH_PAYEE, BigInt.fromString("42"), BigInt.fromString("42"), REF, 3);
    const a2 = spendAuthorized(MANDATE_ID, GRAPH_PAYEE, BigInt.fromString("42"), BigInt.fromString("84"), REF, 4);
    handleSpendAuthorized(a1);
    handleSpendAuthorized(a2);
    assert.entityCount("Action", 2);
    const id1 = a1.transaction.hash.toHexString() + ":3";
    assert.fieldEquals("Action", id1, "mandate", MANDATE);
    assert.fieldEquals("Action", id1, "chain", "base");
    assert.fieldEquals("Action", id1, "allowed", "true");
    assert.fieldEquals("Action", id1, "kind", "authorize");
    assert.fieldEquals("Action", id1, "amount", "42");
    assert.fieldEquals("Action", id1, "target", GRAPH_PAYEE.toHexString());
    assert.fieldEquals("Action", id1, "agent", AGENT_EVM.toHexString());
    assert.fieldEquals("Action", id1, "ref", REF.toHexString());
    assert.fieldEquals("Permission", PERMISSION, "spentTotal", "84");
  });

  test("PaymentExecuted is an allowed Action of kind payment", () => {
    issue();
    const p = paymentExecuted(MANDATE_ID, GRAPH_PAYEE, USDC, BigInt.fromString("10"), BigInt.fromString("10"), 7);
    handlePaymentExecuted(p);
    const id = p.transaction.hash.toHexString() + ":7";
    assert.fieldEquals("Action", id, "kind", "payment");
    assert.fieldEquals("Action", id, "allowed", "true");
    assert.fieldEquals("Permission", PERMISSION, "spentTotal", "10");
  });

  test("revoke flips active; re-issue reactivates and a fresh permission starts at zero", () => {
    issue();
    handleSpendAuthorized(spendAuthorized(MANDATE_ID, GRAPH_PAYEE, BigInt.fromString("42"), BigInt.fromString("42"), REF, 3));
    handleMandateRevoked(mandateRevoked(MANDATE_ID));
    assert.fieldEquals("Mandate", MANDATE, "active", "false");
    issue();
    assert.entityCount("Mandate", 1);
    assert.fieldEquals("Mandate", MANDATE, "active", "true");
    assert.fieldEquals("Permission", PERMISSION, "spentTotal", "0");
    assert.entityCount("Action", 1); // history is never erased
  });

  test("PermissionRemoved deletes the row; events for an unknown mandateId are ignored", () => {
    issue();
    handlePermissionRemoved(permissionRemoved(MANDATE_ID, GRAPH_PAYEE));
    assert.entityCount("Permission", 0);
    const ghost = Bytes.fromHexString("0x" + "ee".repeat(32));
    handleSpendAuthorized(spendAuthorized(ghost, GRAPH_PAYEE, BigInt.fromString("1"), BigInt.fromString("1"), REF, 9));
    handleMandateRevoked(mandateRevoked(ghost));
    assert.entityCount("Action", 0);
    assert.fieldEquals("Mandate", MANDATE, "active", "true");
  });
});
