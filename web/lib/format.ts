/** Display helpers. Amounts always carry their unit; long values truncate in the middle. */

export function truncate(value: string, head = 6, tail = 4): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Base units of a 6-decimal token (USDC on Solana devnet and Hedera) to a human string. */
export function usdc(units: string | bigint | number, decimals = 6): string {
  const v = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} USDC` : `${whole} USDC`;
}

/**
 * The index stores amounts in the chain's own base units. Solana rows are devnet USDC (6 dp);
 * Base rows are The Graph's per-query "units" of USDC (42 per query); Sepolia rows are lifecycle
 * events with no amount.
 */
export function amountFor(chain: string, amount: string): string {
  if (!amount || amount === "0") return "0";
  if (chain === "solana") return usdc(amount);
  if (chain === "base") return `${Number(amount).toLocaleString()} units`;
  return amount;
}

export function timeAgo(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - unixSeconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function untilExpiry(expiryUnix: number, now = Date.now() / 1000): { expired: boolean; text: string } {
  const s = Math.round(expiryUnix - now);
  if (s <= 0) return { expired: true, text: `expired ${timeAgo(expiryUnix, now)}` };
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 48) return { expired: false, text: `expires in ${Math.floor(h / 24)} d` };
  return { expired: false, text: `expires in ${h} h ${m} min` };
}

export const isoDate = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** Headroom of a cap as a fraction 0..1; null when the cap is unlimited (0). */
export function headroom(spent: string, cap: string): number | null {
  const c = BigInt(cap);
  if (c === 0n) return null;
  const s = BigInt(spent);
  const used = Number((s * 10_000n) / c) / 10_000;
  return Math.max(0, Math.min(1, 1 - used));
}
