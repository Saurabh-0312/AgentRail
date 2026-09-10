import { describe, expect, it } from "vitest";

import { ASSETS, CHAIN_ASSET, assetForChain, chainKeyFromCaip, formatAsset, formatChainAmount, formatUnits, group, tryFormatUnits } from "../lib/units";

describe("formatUnits", () => {
  it("turns the caps a judge sees into their human value, keeping the raw figure", () => {
    expect(formatUnits("30000", 6, "USDC")).toMatchObject({ human: "0.03 USDC", value: "0.03", raw: "30,000", units: 30000n });
    expect(formatUnits("50000", 6, "USDC")).toMatchObject({ human: "0.05 USDC", raw: "50,000" });
    expect(formatUnits("42", 6, "USDC")).toMatchObject({ human: "0.000042 USDC", raw: "42" });
    expect(formatUnits(1_000_000, 6, "USDC").human).toBe("1 USDC");
    expect(formatUnits(1_500_000n, 6, "USDC").human).toBe("1.5 USDC");
  });

  it("uses the right decimals per asset", () => {
    expect(formatUnits("100000000", 8, "HBAR").human).toBe("1 HBAR");
    expect(formatUnits("12345678", 8, "HBAR").human).toBe("0.12345678 HBAR");
    expect(formatUnits("1000000000", 9, "SOL").human).toBe("1 SOL");
    expect(formatUnits("1", 9, "SOL").human).toBe("0.000000001 SOL");
    expect(formatUnits("7", 0, "units").human).toBe("7 units");
  });

  it("is exact on the largest figure the chain can hold", () => {
    const max = formatUnits("18446744073709551615", 6, "USDC");
    expect(max.human).toBe("18,446,744,073,709.551615 USDC");
    expect(max.raw).toBe("18,446,744,073,709,551,615");
    expect(max.units).toBe(18446744073709551615n);
  });

  it("groups thousands on both figures and trims trailing zeros, not significant ones", () => {
    expect(formatUnits("1234567890", 6, "USDC")).toMatchObject({ value: "1,234.56789", raw: "1,234,567,890" });
    expect(formatUnits("1000000000", 6, "USDC").value).toBe("1,000");
    expect(formatUnits("0", 6, "USDC")).toMatchObject({ human: "0 USDC", raw: "0" });
    expect(formatUnits("100", 6, "USDC").value).toBe("0.0001");
    expect(group("1234567")).toBe("1,234,567");
    expect(group("12")).toBe("12");
  });

  it("refuses anything that is not an integer number of base units", () => {
    expect(() => formatUnits("1.5", 6, "USDC")).toThrow(RangeError);
    expect(() => formatUnits("abc", 6, "USDC")).toThrow(RangeError);
    expect(() => formatUnits("", 6, "USDC")).toThrow(RangeError);
    expect(() => formatUnits(1.5, 6, "USDC")).toThrow(RangeError);
    expect(() => formatUnits("1", -1, "USDC")).toThrow(RangeError);
    expect(formatUnits("-30000", 6, "USDC")).toMatchObject({ human: "-0.03 USDC", raw: "-30,000" });
  });

  it("has a forgiving form for a field mid-edit", () => {
    expect(tryFormatUnits("", 6, "USDC")).toBeNull();
    expect(tryFormatUnits("12a", 6, "USDC")).toBeNull();
    expect(tryFormatUnits(undefined, 6, "USDC")).toBeNull();
    expect(tryFormatUnits(" 30000 ", 6, "USDC")?.human).toBe("0.03 USDC");
  });
});

describe("the asset registry", () => {
  it("knows the decimals and the identifier of every asset the mandates settle in", () => {
    expect(ASSETS["usdc-hedera"]).toMatchObject({ decimals: 6, symbol: "USDC", id: "0.0.429274", chain: "hedera" });
    expect(ASSETS["usdc-base"]).toMatchObject({ decimals: 6, symbol: "USDC", id: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", chain: "base" });
    expect(ASSETS["usdc-solana"]).toMatchObject({ decimals: 6, symbol: "USDC", id: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", chain: "solana" });
    expect(ASSETS.hbar).toMatchObject({ decimals: 8, symbol: "HBAR" });
    expect(ASSETS.sol).toMatchObject({ decimals: 9, symbol: "SOL" });
  });

  it("maps every enforced chain to USDC, and the name chain to nothing", () => {
    expect(CHAIN_ASSET).toEqual({ solana: "usdc-solana", hedera: "usdc-hedera", base: "usdc-base" });
    expect(formatChainAmount("hedera", "30000")?.human).toBe("0.03 USDC");
    expect(formatChainAmount("base", "42")?.human).toBe("0.000042 USDC");
    expect(formatChainAmount("solana", "2000000")?.human).toBe("2 USDC");
    expect(formatChainAmount("sepolia", "1")).toBeNull();
    expect(formatChainAmount("hedera", "not-a-number")).toBeNull();
    expect(assetForChain("base")?.symbol).toBe("USDC");
    expect(assetForChain("sepolia")).toBeNull();
    expect(formatAsset("500000", "usdc-solana").human).toBe("0.5 USDC");
  });

  it("reads the CAIP-2 ids rail.allowed uses", () => {
    expect(chainKeyFromCaip("solana:devnet")).toBe("solana");
    expect(chainKeyFromCaip("hedera:testnet")).toBe("hedera");
    expect(chainKeyFromCaip("eip155:84532")).toBe("base");
    expect(chainKeyFromCaip("eip155:11155111")).toBe("sepolia");
    expect(chainKeyFromCaip("cosmos:hub")).toBeNull();
  });
});
