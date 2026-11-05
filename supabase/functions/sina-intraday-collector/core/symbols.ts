// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import type { OkxInstrument, OkxSwapTicker } from "./okx.ts";

export const DEFAULT_SYMBOLS = ["BZ", "SNDK", "MU", "META", "NVDA", "QQQ", "MRNA", "TSM", "XAU", "BTC", "ETH"] as const;

export const SYMBOL_PATTERN = /^[A-Z0-9]{1,20}$/;

export function parseSymbolList(input: string | null | undefined): string[] {
  const raw = input && input.trim() !== "" ? input.split(",") : [...DEFAULT_SYMBOLS];
  const symbols: string[] = [];
  for (const part of raw) {
    const symbol = part.trim().toUpperCase();
    if (symbol === "") continue;
    if (!SYMBOL_PATTERN.test(symbol)) {
      throw new Error(`invalid symbol "${part.trim()}"`);
    }
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  if (symbols.length === 0) throw new Error("symbol list is empty");
  return symbols;
}

/**
 * Picks the live OKX USDT-margined perpetual for a base symbol, falling back
 * to a USD-margined swap if no USDT contract exists.
 */
export function pickSwapInstId(symbol: string, instruments: readonly OkxInstrument[]): string | null {
  const live = instruments.filter((i) => i.instType === "SWAP" && i.state === "live");
  for (const quote of ["USDT", "USD"]) {
    const instId = `${symbol}-${quote}-SWAP`;
    if (live.some((i) => i.instId === instId)) return instId;
  }
  return null;
}

/** OKX stock-token perpetuals use either the plain ticker or a vendor-prefixed base (e.g. SKHYNIX for SK hynix). */
const OKX_STOCK_BASE_ALIASES: Record<string, string> = {
  SKHY: "SKHYNIX",
};

/**
 * Resolves the symbol for a swap instId, honouring aliases that plain base
 * extraction would miss: SKHYNIX-USDT-SWAP tracks SKHY when symbol_map says so.
 */
export function symbolForInstId(instId: string, knownSymbols: ReadonlySet<string>): string {
  const base = instId.split("-")[0] ?? instId;
  if (knownSymbols.has(base)) return base;
  for (const [symbol, alias] of Object.entries(OKX_STOCK_BASE_ALIASES)) {
    if (alias === base && knownSymbols.has(symbol)) return symbol;
  }
  return base;
}

/**
 * Best-effort Yahoo symbol for a newly tracked OKX perpetual. Crypto and
 * commodity bases map mechanically; plain US tickers map to themselves.
 * Anything unrecognized returns null, which simply skips Yahoo collection
 * for that symbol (OKX collection is unaffected).
 */
export function guessYahooSymbol(symbol: string): string | null {
  if (symbol === "XAU") return null;
  if (symbol === "BZ") return "BZ=F";
  if (symbol === "CL") return "CL=F";
  if (/^[A-Z]{1,6}$/.test(symbol)) return symbol;
  return null;
}

export interface UniverseEntry {
  rank: number;
  instId: string;
  symbol: string;
  last: number;
  /** 24h turnover in the quote currency (volCcy24h * last); the only honest ranking key. */
  turnover: number;
  change24h: number | null;
  tracked: boolean;
}

/**
 * Ranks swap tickers by 24h turnover (base volume * last price). Ranking by
 * volCcy24h alone would crown tiny-priced meme coins whose base-unit volume
 * is astronomically large but economically small.
 */
export function rankUniverse(
  tickers: readonly OkxSwapTicker[],
  symbolByInstId: ReadonlyMap<string, string>,
  limit: number,
): UniverseEntry[] {
  const knownSymbols = new Set(symbolByInstId.values());
  return tickers
    .map((ticker) => ({ ticker, turnover: ticker.volCcy24h * ticker.last }))
    .filter(({ turnover }) => turnover > 0)
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, Math.max(0, limit))
    .map(({ ticker, turnover }, index) => ({
      rank: index + 1,
      instId: ticker.instId,
      symbol: symbolByInstId.get(ticker.instId) ?? symbolForInstId(ticker.instId, knownSymbols),
      last: ticker.last,
      turnover,
      change24h: ticker.change24h,
      tracked: symbolByInstId.has(ticker.instId),
    }));
}
