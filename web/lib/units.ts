/**
 * One helper for every amount in the app. The chains and the index store amounts in base units
 * (30000 on Hedera is 0.03 USDC; 42 on Base is 0.000042 USDC); a judge reads the human value, a
 * developer can still see the raw one. No component formats an amount on its own.
 */
import type { ChainKey } from "./chains";

export type AssetKey = "usdc-solana" | "usdc-hedera" | "usdc-base" | "hbar" | "sol";

export interface Asset {
  key: AssetKey;
  symbol: string;
  decimals: number;
  chain: ChainKey;
  /** The on-chain identifier: the devnet mint, the HTS token id, the ERC-20 address, or native. */
  id: string;
  label: string;
}

export const ASSETS: Record<AssetKey, Asset> = {
  "usdc-solana": { key: "usdc-solana", symbol: "USDC", decimals: 6, chain: "solana", id: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", label: "USDC, Solana devnet mint" },
  "usdc-hedera": { key: "usdc-hedera", symbol: "USDC", decimals: 6, chain: "hedera", id: "0.0.429274", label: "USDC, Hedera HTS 0.0.429274" },
  "usdc-base": { key: "usdc-base", symbol: "USDC", decimals: 6, chain: "base", id: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", label: "USDC, Base Sepolia" },
  hbar: { key: "hbar", symbol: "HBAR", decimals: 8, chain: "hedera", id: "0.0.0", label: "HBAR, in tinybars" },
  sol: { key: "sol", symbol: "SOL", decimals: 9, chain: "solana", id: "native", label: "SOL, in lamports" },
};

/** The asset every mandate on that chain is denominated in: its caps, its spend and its prices are base units of this. */
export const CHAIN_ASSET: Partial<Record<ChainKey, AssetKey>> = { solana: "usdc-solana", hedera: "usdc-hedera", base: "usdc-base" };

export interface FormattedUnits {
  /** What a judge reads: "0.03 USDC". */
  human: string;
  /** The number alone: "0.03". */
  value: string;
  /** The base units with separators: "30,000". */
  raw: string;
  /** The base units as given. */
  units: bigint;
  symbol: string;
  decimals: number;
}

/** "1234567" -> "1,234,567". */
export function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function toBigInt(amount: string | number | bigint): bigint {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) throw new RangeError(`not an integer amount: ${amount}`);
    return BigInt(amount);
  }
  const s = amount.trim();
  if (!/^-?\d+$/.test(s)) throw new RangeError(`not an integer amount: ${JSON.stringify(amount)}`);
  return BigInt(s);
}

/**
 * Base units of a token to its human value. Exact: bigint arithmetic, no floating point, trailing
 * zeros trimmed, thousands grouped on both figures.
 */
export function formatUnits(amount: string | number | bigint, decimals: number, symbol: string): FormattedUnits {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`decimals must be a non-negative integer: ${decimals}`);
  const units = toBigInt(amount);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = group((abs / scale).toString());
  const frac = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const value = `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
  return { human: `${value} ${symbol}`, value, raw: `${negative ? "-" : ""}${group(abs.toString())}`, units, symbol, decimals };
}

/** The same, for input that may not be a number yet (a form field mid-edit). */
export function tryFormatUnits(amount: string | number | bigint | null | undefined, decimals: number, symbol: string): FormattedUnits | null {
  if (amount === null || amount === undefined || amount === "") return null;
  try {
    return formatUnits(amount, decimals, symbol);
  } catch {
    return null;
  }
}

export function formatAsset(amount: string | number | bigint, asset: AssetKey): FormattedUnits {
  const a = ASSETS[asset];
  return formatUnits(amount, a.decimals, a.symbol);
}

/** An amount in the mandate's asset on that chain; null where the chain settles nothing (Sepolia holds the name, not a spend gate). */
export function formatChainAmount(chain: string, amount: string | number | bigint | null | undefined): FormattedUnits | null {
  const key = CHAIN_ASSET[chain as ChainKey];
  if (!key) return null;
  return tryFormatUnits(amount, ASSETS[key].decimals, ASSETS[key].symbol);
}

export const assetForChain = (chain: string): Asset | null => {
  const key = CHAIN_ASSET[chain as ChainKey];
  return key ? ASSETS[key] : null;
};

/** The rail.allowed record names chains as CAIP-2 ids. */
export function chainKeyFromCaip(caip: string): ChainKey | null {
  switch (caip) {
    case "solana:devnet":
      return "solana";
    case "hedera:testnet":
      return "hedera";
    case "eip155:84532":
      return "base";
    case "eip155:11155111":
      return "sepolia";
    default:
      return null;
  }
}
