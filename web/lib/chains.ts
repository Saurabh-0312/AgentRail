/**
 * Everything the UI knows about a chain: its name, its colour token, and how to build a link a
 * judge can click. Every hash, address and name on the site goes through these builders, so
 * nothing is asserted that cannot be verified.
 */
export type ChainKey = "sepolia" | "base" | "solana" | "hedera";

export interface ChainMeta {
  key: ChainKey;
  label: string;
  short: string;
  /** Tailwind colour token, from the palette in globals.css. */
  color: "ens" | "graph" | "hedera" | "solana";
  caip: string;
  tx: (id: string) => string;
  address: (addr: string) => string;
}

export const CHAINS: Record<ChainKey, ChainMeta> = {
  sepolia: {
    key: "sepolia",
    label: "Ethereum Sepolia (ENSv2)",
    short: "Sepolia",
    color: "ens",
    caip: "eip155:11155111",
    tx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    address: (a) => `https://sepolia.etherscan.io/address/${a}`,
  },
  base: {
    key: "base",
    label: "Base Sepolia",
    short: "Base",
    color: "graph",
    caip: "eip155:84532",
    tx: (h) => `https://sepolia.basescan.org/tx/${h}`,
    address: (a) => `https://sepolia.basescan.org/address/${a}`,
  },
  solana: {
    key: "solana",
    label: "Solana devnet",
    short: "Solana",
    color: "solana",
    caip: "solana:devnet",
    tx: (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    address: (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`,
  },
  hedera: {
    key: "hedera",
    label: "Hedera testnet",
    short: "Hedera",
    color: "hedera",
    caip: "hedera:testnet",
    // `0.0.7162784@1789035240.310880451` -> `0.0.7162784-1789035240-310880451`
    tx: (id) => `https://hashscan.io/testnet/transaction/${id.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`,
    address: (a) => `https://hashscan.io/testnet/account/${a}`,
  },
};

/** The CAIP-2 ids the ENS records carry (`rail.chain`), mapped to our keys. */
export function chainFromCaip(caip: string): ChainKey | null {
  const hit = (Object.values(CHAINS) as ChainMeta[]).find((c) => c.caip === caip);
  return hit?.key ?? null;
}

export const HCS_TOPIC_URL = (topic: string) => `https://hashscan.io/testnet/topic/${topic}`;
export const ENS_APP_URL = (name: string) => `https://sepolia.app.ens.domains/${name}`;

/** Anchor error numbers of the AgentRail program (SPEC §8.1.1) plus the Anchor framework codes a closed account produces. */
export const ERROR_NAMES: Record<number, string> = {
  6000: "NotActive",
  6001: "Expired",
  6002: "PermissionsFull",
  6003: "PermissionNotFound",
  6004: "DuplicatePermission",
  6005: "ProgramNotAllowed",
  6006: "InstructionNotAllowed",
  6007: "PerTxLimitExceeded",
  6008: "SpendLimitExceeded",
  6009: "Unauthorized",
  6010: "NotTheAgent",
  6011: "InvalidDiscriminatorSize",
  6012: "TooManyDiscriminators",
  6013: "InvalidExpiry",
  6014: "Overflow",
  6015: "InvalidTargetInstruction",
  6016: "DestinationNotAllowed",
  6017: "TokenAccountNotOwned",
  3007: "AccountOwnedByWrongProgram",
  3012: "AccountNotInitialized",
};

/** What a judge should read next to the code. */
export const ERROR_REASONS: Record<number, string> = {
  6000: "the mandate is not active",
  6001: "the mandate has expired",
  6005: "the program is not on the mandate",
  6006: "the instruction is not on the mandate (same program, different button)",
  6007: "over the per-transaction cap",
  6008: "over the lifetime cap",
  6009: "signer is not the owner",
  6010: "signer is not the mandated agent",
  6015: "the sibling instruction is out of range",
  6016: "the destination is not on the mandate's allowed list",
  6017: "the token account is not the owner's",
  3007: "the mandate account no longer exists: the owner revoked it",
  3012: "the mandate account was never initialised",
};

export const errorName = (code: number | null | undefined) => (code ? (ERROR_NAMES[code] ?? `error ${code}`) : null);
export const errorReason = (code: number | null | undefined) => (code ? (ERROR_REASONS[code] ?? "refused by the program") : null);
