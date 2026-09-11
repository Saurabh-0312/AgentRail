/**
 * The token a mandate settles in on each EVM chain, as the address a contract can pull from with
 * `transferFrom`. Derived from the asset registry in units.ts; no component carries an address.
 */
import type { Address } from "viem";

import type { ChainKey } from "./chains";
import { ASSETS, CHAIN_ASSET, type Asset } from "./units";

/** `0.0.429274` -> `0x0000000000000000000000000000000000068cda`: an HTS token as the EVM sees it (long-zero form). */
export function hederaLongZero(id: string): Address {
  const m = id.match(/^0\.0\.(\d+)$/);
  if (!m) throw new RangeError(`not a Hedera entity id: ${id}`);
  return `0x${BigInt(m[1]).toString(16).padStart(40, "0")}` as Address;
}

export interface ChainToken {
  asset: Asset;
  /** The ERC-20 address `EvmMandate.executePayment` pulls from. */
  address: Address;
}

/** USDC on Base Sepolia and HTS USDC on Hedera testnet; Solana delegates an SPL mint, not an ERC-20. */
export function tokenFor(chain: ChainKey | string): ChainToken | null {
  const key = CHAIN_ASSET[chain as ChainKey];
  if (!key) return null;
  const asset = ASSETS[key];
  if (chain === "hedera") return { asset, address: hederaLongZero(asset.id) };
  if (chain === "base") return { asset, address: asset.id as Address };
  return null;
}

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
