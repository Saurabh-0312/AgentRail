/**
 * Live spot prices. Coinbase's public price API needs no key; CoinGecko is the fallback.
 * Nothing here is a fixture: every paid response carries a price fetched at request time.
 */

export interface Quote {
  symbol: string;
  price: number;
  currency: "USD";
  source: string;
  fetchedAt: string;
}

export type QuoteFetcher = (symbols: string[]) => Promise<Quote[]>;

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  HBAR: "hedera-hashgraph",
  USDC: "usd-coin",
  LINK: "chainlink",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  DOGE: "dogecoin",
  ADA: "cardano",
};

export const SUPPORTED_SYMBOLS = Object.keys(COINGECKO_IDS);

async function coinbaseSpot(symbol: string): Promise<Quote> {
  const r = await fetch(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`);
  if (!r.ok) throw new Error(`coinbase ${symbol}: HTTP ${r.status}`);
  const d = (await r.json()) as { data?: { amount?: string } };
  const price = Number(d.data?.amount);
  if (!Number.isFinite(price)) throw new Error(`coinbase ${symbol}: no price`);
  return { symbol, price, currency: "USD", source: "coinbase", fetchedAt: new Date().toISOString() };
}

async function coingeckoSimple(symbols: string[]): Promise<Quote[]> {
  const ids = symbols.map((s) => COINGECKO_IDS[s]).join(",");
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  if (!r.ok) throw new Error(`coingecko: HTTP ${r.status}`);
  const d = (await r.json()) as Record<string, { usd?: number }>;
  const at = new Date().toISOString();
  return symbols.map((symbol) => {
    const price = d[COINGECKO_IDS[symbol]]?.usd;
    if (!Number.isFinite(price)) throw new Error(`coingecko ${symbol}: no price`);
    return { symbol, price: price as number, currency: "USD", source: "coingecko", fetchedAt: at };
  });
}

/** Coinbase per symbol, CoinGecko for the whole batch if Coinbase fails. */
export const liveQuotes: QuoteFetcher = async (symbols) => {
  try {
    return await Promise.all(symbols.map(coinbaseSpot));
  } catch {
    return coingeckoSimple(symbols);
  }
};

/** Validate a `SOL,HBAR,ETH` path segment. Returns null on anything unknown, empty, or duplicated. */
export function parseSymbols(raw: string, max: number): string[] | null {
  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0 || symbols.length > max) return null;
  if (new Set(symbols).size !== symbols.length) return null;
  if (!symbols.every((s) => s in COINGECKO_IDS)) return null;
  return symbols;
}
