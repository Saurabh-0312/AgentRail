/** SPL Token instruction tags, the 1-byte discriminators a Solana mandate lists (SPEC §8.1.1). */
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const SPL_TAG_NAMES: Record<number, string> = {
  3: "Transfer",
  4: "Approve",
  5: "Revoke",
  6: "SetAuthority",
  7: "MintTo",
  8: "Burn",
  9: "CloseAccount",
  12: "TransferChecked",
  13: "ApproveChecked",
};

/** `0x0300000000000000` -> "Transfer (3)". Unknown tags are shown by number. */
export function describeInstruction(hex: string): string {
  const tag = parseInt(hex.replace(/^0x/, "").slice(0, 2), 16);
  if (Number.isNaN(tag)) return hex;
  return `${SPL_TAG_NAMES[tag] ?? "instruction"} (${tag})`;
}

/** Hedera's long-zero EVM alias (`0x…009f4f57`) back to the account id (`0.0.10440535`). */
export function hederaAccountFromLongZero(address: string): string | null {
  const m = address.toLowerCase().match(/^0x0{24}([0-9a-f]{16})$/);
  return m ? `0.0.${parseInt(m[1], 16)}` : null;
}
