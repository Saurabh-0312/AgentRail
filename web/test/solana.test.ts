import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { catalogueProgram, discriminatorBytes, toHex } from "@agentrail/sdk/src/solana/catalogue.ts";

import { solanaOwnerGate } from "../components/solana-create";
import { AGENTRAIL_PROGRAM, MAX_DISCRIMINATORS, MAX_PERMISSIONS, defaultDraft, derivePda, ensNodeOf, paymentPermission, programPermission, solanaErrorText, toAddPermissionArgs, totalLifetime, validateDraft, type PermissionDraft } from "../lib/solana-form";
import { formatAsset } from "../lib/units";

const OWNER = "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb";
const AGENT = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const KNOWN_PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const SHOP_ATA = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";

function valid(): ReturnType<typeof defaultDraft> {
  const d = defaultDraft("databot.agentrail.eth");
  d.agent = AGENT;
  const payee = d.permissions.find((p) => p.kind === "payment")!;
  (payee as Extract<PermissionDraft, { kind: "payment" }>).destination = SHOP_ATA;
  return d;
}

describe("the catalogue, as the form uses it", () => {
  it("returns the right tag and width per program: SPL Token 1, System 4, Anchor 8", () => {
    expect(catalogueProgram("spl-token")?.width).toBe(1);
    expect(catalogueProgram("system")?.width).toBe(4);
    expect(programPermission("spl-token").kind === "program" && (programPermission("spl-token") as Extract<PermissionDraft, { kind: "program" }>).width).toBe(1);
    expect((programPermission("system") as Extract<PermissionDraft, { kind: "program" }>).width).toBe(4);
    expect(toHex(discriminatorBytes(1, 3))).toBe("0x03");
    expect(toHex(discriminatorBytes(4, 2))).toBe("0x02000000");
  });
});

describe("what add_permission receives", () => {
  it("encodes a Transfer-only SPL Token permission exactly as the CLI does: one 1-byte tag, left-aligned in an 8-byte slot", () => {
    const p = programPermission("spl-token") as Extract<PermissionDraft, { kind: "program" }>;
    p.tags = [3];
    p.perTx = "1000000";
    p.total = "2000000";
    const args = toAddPermissionArgs(p);
    expect(args.key).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(args.discriminators).toEqual([[3, 0, 0, 0, 0, 0, 0, 0]]);
    expect(args.size).toBe(1);
    expect(args.spendLimit).toBe(2000000n);
    expect(args.perTxLimit).toBe(1000000n);
  });

  it("encodes a payee as a destination with no discriminators, width 1, as the devnet demo does", () => {
    const p = paymentPermission() as Extract<PermissionDraft, { kind: "payment" }>;
    p.destination = SHOP_ATA;
    const args = toAddPermissionArgs(p);
    expect(args).toMatchObject({ key: SHOP_ATA, discriminators: [], size: 1, spendLimit: 5000000n, perTxLimit: 2000000n });
  });

  it("accepts raw hex at the declared width and refuses the wrong length", () => {
    const p = programPermission("spl-token") as Extract<PermissionDraft, { kind: "program" }>;
    p.program = "custom";
    p.programId = AGENTRAIL_PROGRAM;
    p.width = 8;
    p.tags = [];
    p.customHex = ["0x0102030405060708"];
    expect(toAddPermissionArgs(p).discriminators).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
    p.customHex = ["0x0102"];
    expect(() => toAddPermissionArgs(p)).toThrow(/exactly 8 bytes/);
  });
});

describe("the form refuses what the program would refuse", () => {
  it("passes a sensible draft", () => {
    expect(validateDraft(valid())).toEqual({ ok: true, errors: [] });
  });

  it("rejects more than 16 permissions with a clear message", () => {
    const d = valid();
    // every payee distinct, so only the count trips
    while (d.permissions.length <= MAX_PERMISSIONS) {
      const p = paymentPermission() as Extract<PermissionDraft, { kind: "payment" }>;
      p.destination = Keypair.generate().publicKey.toBase58();
      d.permissions.push(p);
    }
    const v = validateDraft(d);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/at most 16 permissions/);
  });

  it("rejects more than 8 discriminators on one program with a clear message", () => {
    const d = valid();
    const p = d.permissions.find((x) => x.kind === "program") as Extract<PermissionDraft, { kind: "program" }>;
    p.tags = [3, 4, 5, 6, 8, 9, 12, 13];
    p.customHex = ["0x0f"];
    const v = validateDraft(d);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(new RegExp(`at most ${MAX_DISCRIMINATORS} instructions per program`));
  });

  it("rejects an empty instruction list, a duplicate key and a per-tx cap above the lifetime cap", () => {
    const d = valid();
    const p = d.permissions.find((x) => x.kind === "program") as Extract<PermissionDraft, { kind: "program" }>;
    p.tags = [];
    expect(validateDraft(d).errors.join("\n")).toMatch(/pick at least one instruction/);
    p.tags = [3];
    d.permissions.push({ ...programPermission("spl-token"), tags: [3] } as PermissionDraft);
    expect(validateDraft(d).errors.join("\n")).toMatch(/DuplicatePermission/);
    d.permissions.pop();
    p.perTx = "3000000";
    p.total = "2000000";
    expect(validateDraft(d).errors.join("\n")).toMatch(/exceeds the lifetime cap/);
  });
});

describe("what the owner sees before signing", () => {
  it("derives the PDA from [b\"mandate\", owner, agent]: the demo's known account", () => {
    expect(derivePda(OWNER, AGENT)).toBe(KNOWN_PDA);
    expect(derivePda(OWNER, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).not.toBe(KNOWN_PDA);
  });

  it("shows the ENS namehash that becomes ens_node, the join key of the proof layer", () => {
    expect(ensNodeOf("databot.agentrail.eth")).toBe("0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae");
    expect(ensNodeOf("  DataBot.AgentRail.eth ")).toBe("0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae");
  });

  it("converts base units of devnet USDC live", () => {
    expect(formatAsset("2000000", "usdc-solana").human).toBe("2 USDC");
    expect(formatAsset("5000000", "usdc-solana").human).toBe("5 USDC");
    expect(formatAsset("1", "usdc-solana").human).toBe("0.000001 USDC");
  });

  it("pre-fills the delegation from the lifetime caps summed", () => {
    const d = valid();
    expect(totalLifetime(d.permissions)).toBe("7000000");
    expect(d.approveAmount).toBe("7000000");
  });

  it("names the program's own error codes when a transaction reverts", () => {
    expect(solanaErrorText({ error: { errorCode: { number: 6004, code: "DuplicatePermission" } } })).toMatch(/^6004 DuplicatePermission/);
    expect(solanaErrorText(new Error("AnchorError occurred. Error Code: TooManyDiscriminators. Error Number: 6012. Error Message: too many"))).toMatch(/^6012 TooManyDiscriminators/);
    expect(solanaErrorText(new Error("Transaction simulation failed: custom program error: 0x1775"))).toMatch(/^6005 ProgramNotAllowed/);
    expect(solanaErrorText(new Error("User rejected the request"))).toBe("User rejected the request");
  });
});

describe("the Solana owner gate", () => {
  it("is read-only for a visitor and for the wrong wallet, enabled for the owner", () => {
    expect(solanaOwnerGate(null, OWNER)).toMatchObject({ enabled: false, state: "disconnected" });
    expect(solanaOwnerGate(AGENT, OWNER)).toMatchObject({ enabled: false, state: "wrong-account" });
    expect(solanaOwnerGate(OWNER, OWNER)).toMatchObject({ enabled: true, state: "owner" });
    expect(solanaOwnerGate(null, OWNER).reason).toMatch(/Solana wallet/);
  });
});
