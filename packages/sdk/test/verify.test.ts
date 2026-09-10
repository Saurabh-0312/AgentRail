import { describe, expect, it } from "vitest";

import {
  MandateRefused,
  SPL_TOKEN_PROGRAM,
  SPL_TOKEN_TAG,
  discriminatorAllowed,
  solanaLocalVerifyGate,
  splTokenAmount,
  type SiblingInstruction,
  type SolanaMandateState,
} from "../src/index.ts";

const AGENT = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const OWNER_ATA = "AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const NOW = 1_800_000_000n;

/** A 1-byte SPL tag, left-aligned in the 8-byte slot the account stores. */
const slot = (tag: number) => "0x" + Buffer.from([tag, 0, 0, 0, 0, 0, 0, 0]).toString("hex");
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return [...b];
};
/** An SPL Token instruction on the owner's account: `[tag]` or `[tag, amount u64 LE]`. */
const tokenIx = (tag: number, amount?: bigint): SiblingInstruction => ({
  programId: SPL_TOKEN_PROGRAM,
  keys: [{ pubkey: OWNER_ATA, isSigner: false, isWritable: true }],
  data: new Uint8Array(amount === undefined ? [tag] : [tag, ...u64le(amount)]),
});
/** The devnet mandate's SPL Token entry: 1-byte discriminators, 1 USDC per tx, 2 USDC lifetime. */
const state = (tags: number[], over: Partial<SolanaMandateState> = {}, spendTotal = 500_000n): SolanaMandateState => ({
  active: true,
  expiry: 4_000_000_000n,
  agent: AGENT,
  permissions: [{ key: SPL_TOKEN_PROGRAM, spendLimit: 2_000_000n, perTxLimit: 1_000_000n, spendTotal, discriminators: tags.map(slot), discriminatorSize: 1 }],
  ...over,
});
const verdict = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MandateRefused) return e.reason;
    throw e;
  }
  return "allowed";
};

describe("solanaLocalVerifyGate: the same order as verify.rs", () => {
  it("allows a listed instruction and reads the amount from the instruction data, not the caller", () => {
    const r = solanaLocalVerifyGate(state([SPL_TOKEN_TAG.transfer]), NOW, AGENT, tokenIx(SPL_TOKEN_TAG.transfer, 500_000n), 0n);
    expect(r.amount).toBe(500_000n);
    expect(r.permission.key).toBe(SPL_TOKEN_PROGRAM);
  });

  it("refuses SetAuthority on the same program: InstructionNotAllowed (6006)", () => {
    expect(verdict(() => solanaLocalVerifyGate(state([SPL_TOKEN_TAG.transfer]), NOW, AGENT, tokenIx(SPL_TOKEN_TAG.setAuthority), 0n))).toBe("InstructionNotAllowed");
  });

  it("refuses Revoke until the owner lists it, then allows it with the declared amount", () => {
    expect(verdict(() => solanaLocalVerifyGate(state([SPL_TOKEN_TAG.transfer]), NOW, AGENT, tokenIx(SPL_TOKEN_TAG.revoke), 0n))).toBe("InstructionNotAllowed");
    const r = solanaLocalVerifyGate(state([SPL_TOKEN_TAG.transfer, SPL_TOKEN_TAG.revoke]), NOW, AGENT, tokenIx(SPL_TOKEN_TAG.revoke), 0n);
    expect(r.amount).toBe(0n);
  });

  it("refuses a program with no entry before looking at any discriminator", () => {
    const other: SiblingInstruction = { programId: SYSTEM_PROGRAM, keys: [], data: new Uint8Array([2, 0, 0, 0]) };
    expect(verdict(() => solanaLocalVerifyGate(state([SPL_TOKEN_TAG.transfer]), NOW, AGENT, other, 0n))).toBe("ProgramNotAllowed");
  });

  it("applies the per-tx and lifetime caps to the parsed amount", () => {
    expect(verdict(() => solanaLocalVerifyGate(state([3]), NOW, AGENT, tokenIx(3, 1_500_000n), 0n))).toBe("PerTxLimitExceeded");
    expect(verdict(() => solanaLocalVerifyGate(state([3], {}, 1_500_000n), NOW, AGENT, tokenIx(3, 900_000n), 0n))).toBe("SpendLimitExceeded");
    expect(verdict(() => solanaLocalVerifyGate(state([3], {}, 1_000_000n), NOW, AGENT, tokenIx(3, 900_000n), 0n))).toBe("allowed");
  });

  it("refuses a revoked, expired or foreign mandate first", () => {
    expect(verdict(() => solanaLocalVerifyGate(null, NOW, AGENT, tokenIx(3, 1n), 0n))).toBe("NotActive");
    expect(verdict(() => solanaLocalVerifyGate(state([3], { active: false }), NOW, AGENT, tokenIx(3, 1n), 0n))).toBe("NotActive");
    expect(verdict(() => solanaLocalVerifyGate(state([3], { expiry: NOW }), NOW, AGENT, tokenIx(3, 1n), 0n))).toBe("Expired");
    expect(verdict(() => solanaLocalVerifyGate(state([3], { agent: OWNER_ATA }), NOW, AGENT, tokenIx(3, 1n), 0n))).toBe("NotTheAgent");
  });
});

describe("discriminator and amount mirrors", () => {
  const p = { key: SPL_TOKEN_PROGRAM, spendLimit: 0n, perTxLimit: 0n, spendTotal: 0n, discriminators: [slot(3)], discriminatorSize: 1 };

  it("compares only the permission's discriminator width", () => {
    expect(discriminatorAllowed(p, new Uint8Array([3, 9, 9, 9, 9, 9, 9, 9, 9]))).toBe(true);
    expect(discriminatorAllowed({ ...p, discriminatorSize: 8 }, new Uint8Array([3, 9, 9, 9, 9, 9, 9, 9, 9]))).toBe(false);
    expect(discriminatorAllowed({ ...p, discriminatorSize: 2 }, new Uint8Array([3, 0]))).toBe(false);
    expect(discriminatorAllowed({ ...p, discriminators: undefined }, new Uint8Array([3]))).toBe(false);
  });

  it("reads amounts only from the token instructions that carry one", () => {
    expect(splTokenAmount(SPL_TOKEN_PROGRAM, new Uint8Array([3, ...u64le(7n)]))).toBe(7n);
    expect(splTokenAmount(SPL_TOKEN_PROGRAM, new Uint8Array([4, ...u64le(2n ** 64n - 1n)]))).toBe(2n ** 64n - 1n);
    expect(splTokenAmount(SPL_TOKEN_PROGRAM, new Uint8Array([6, ...u64le(7n)]))).toBeNull();
    expect(splTokenAmount(SPL_TOKEN_PROGRAM, new Uint8Array([3, 1]))).toBeNull();
    expect(splTokenAmount(SYSTEM_PROGRAM, new Uint8Array([3, ...u64le(7n)]))).toBeNull();
  });
});
