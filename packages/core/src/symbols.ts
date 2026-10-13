import type { OkxInstrument } from "./okx.js";

export const DEFAULT_SYMBOLS = ["BZ", "SNDK", "MU", "META", "NVDA", "QQQ", "MRNA", "TSM", "XAU", "BTC"] as const;

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
