import { describe, expect, it } from "vitest";

import { ANCHOR_DISCRIMINATOR_WIDTH, PROGRAM_CATALOGUE, SYSTEM_PROGRAM, catalogueProgram, describeDiscriminator, discriminatorBytes, discriminatorSlot, notPermitted, toHex } from "../src/solana/catalogue.ts";
import { SPL_TOKEN_PROGRAM, SPL_TOKEN_TAG, discriminatorAllowed } from "../src/tails/solana.ts";

describe("the instruction catalogue", () => {
  it("carries the discriminator width per program: SPL Token 1, System 4, Anchor 8", () => {
    expect(catalogueProgram("spl-token")?.width).toBe(1);
    expect(catalogueProgram(SPL_TOKEN_PROGRAM)?.width).toBe(1);
    expect(catalogueProgram("spl-token-2022")?.width).toBe(1);
    expect(catalogueProgram("system")?.width).toBe(4);
    expect(catalogueProgram(SYSTEM_PROGRAM)?.width).toBe(4);
    expect(ANCHOR_DISCRIMINATOR_WIDTH).toBe(8);
    expect(catalogueProgram("GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj")).toBeUndefined();
  });

  it("names the SPL Token tags the gate compares, and flags the ones that hand over more than a payment", () => {
    const spl = catalogueProgram("spl-token")!;
    const byName = Object.fromEntries(spl.instructions.map((i) => [i.name, i]));
    expect(byName.Transfer.tag).toBe(SPL_TOKEN_TAG.transfer);
    expect(byName.Transfer.risk).toBeUndefined();
    for (const name of ["Approve", "SetAuthority", "Burn", "CloseAccount", "Revoke"]) expect(byName[name].risk, name).toBeTruthy();
    expect(byName.SetAuthority.tag).toBe(6);
    expect(byName.CloseAccount.tag).toBe(9);
  });

  it("encodes a tag at the program's width: one byte, u32 little-endian, or eight given bytes", () => {
    expect(toHex(discriminatorBytes(1, 3))).toBe("0x03");
    expect(toHex(discriminatorBytes(4, 2))).toBe("0x02000000");
    expect(toHex(discriminatorBytes(4, 0x01020304))).toBe("0x04030201");
    expect(toHex(discriminatorBytes(8, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])))).toBe("0x0102030405060708");
    expect(() => discriminatorBytes(1, 300)).toThrow(RangeError);
    expect(() => discriminatorBytes(8, 5)).toThrow(RangeError);
    expect(() => discriminatorBytes(8, Uint8Array.from([1, 2]))).toThrow(RangeError);
  });

  it("left-aligns the bytes in the 8-byte on-chain slot, exactly as the CLI does", () => {
    expect(discriminatorSlot(discriminatorBytes(1, 3))).toEqual([3, 0, 0, 0, 0, 0, 0, 0]);
    expect(discriminatorSlot(discriminatorBytes(4, 2))).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => discriminatorSlot(new Uint8Array(9))).toThrow(RangeError);
  });

  it("round-trips through the SDK's own gate mirror: a 1-byte Transfer slot admits Transfer and refuses SetAuthority", () => {
    const slot = toHex(discriminatorSlot(discriminatorBytes(1, SPL_TOKEN_TAG.transfer)));
    const permission = { key: SPL_TOKEN_PROGRAM, spendLimit: 0n, perTxLimit: 0n, spendTotal: 0n, discriminators: [slot], discriminatorSize: 1 };
    expect(discriminatorAllowed(permission, Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(discriminatorAllowed(permission, Uint8Array.from([6, 0]))).toBe(false);
    // the width matters: the same slot read as 8 bytes would compare argument data and refuse a real Transfer
    expect(discriminatorAllowed({ ...permission, discriminatorSize: 8 }, Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });

  it("describes stored discriminators and lists what a permission leaves out", () => {
    expect(describeDiscriminator(SPL_TOKEN_PROGRAM, "0x0300000000000000")).toBe("Transfer (3)");
    expect(describeDiscriminator(SPL_TOKEN_PROGRAM, "0x0600000000000000")).toBe("SetAuthority (6)");
    expect(describeDiscriminator(SYSTEM_PROGRAM, "0x0200000000000000")).toBe("Transfer (2)");
    expect(describeDiscriminator("GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj", "0xaabbccdd11223344")).toBe("0xaabbccdd11223344");
    const left = notPermitted(SPL_TOKEN_PROGRAM, ["0x0300000000000000"]).map((i) => i.name);
    expect(left).toContain("SetAuthority");
    expect(left).toContain("Approve");
    expect(left).not.toContain("Transfer");
    expect(notPermitted("unknown-program", [])).toEqual([]);
  });

  it("covers every program the demo mandates name", () => {
    expect(PROGRAM_CATALOGUE.map((p) => p.key)).toEqual(["spl-token", "spl-token-2022", "system"]);
  });
});
