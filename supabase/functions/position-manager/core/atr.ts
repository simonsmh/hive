// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
export interface OhlcBar {
  /** Bar open time in epoch milliseconds (UTC). */
  ts: number;
  high: number;
  low: number;
  close: number;
}

/** Symbols whose daily ATR ignores weekend bars (spot gold trades only on weekdays). */
export const WEEKDAY_ONLY_SYMBOLS: ReadonlySet<string> = new Set(["XAU"]);

export class AtrInsufficientDataError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`ATR needs at least ${required} bars, got ${available}`);
    this.name = "AtrInsufficientDataError";
  }
}

export function isWeekdayUtc(tsMs: number): boolean {
  const day = new Date(tsMs).getUTCDay();
  return day !== 0 && day !== 6;
}

/** Returns bars ascending by time, with weekend bars removed for weekday-only symbols. */
export function prepareBarsForSymbol<T extends OhlcBar>(symbol: string, bars: readonly T[]): T[] {
  const sorted = [...bars].sort((a, b) => a.ts - b.ts);
  return WEEKDAY_ONLY_SYMBOLS.has(symbol.toUpperCase()) ? sorted.filter((b) => isWeekdayUtc(b.ts)) : sorted;
}

export function trueRange(bar: OhlcBar, previousClose: number): number {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
}

export interface AtrResult {
  atr: number;
  period: number;
  barsUsed: number;
}

/**
 * Wilder's ATR. `bars` must be ascending and contain at least period + 1 bars:
 * the first TR needs the previous close, and the seed ATR is the simple mean of
 * the first `period` true ranges, after which Wilder smoothing is applied.
 */
export function computeAtr(bars: readonly OhlcBar[], period: number): AtrResult {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError("period must be a positive integer");
  }
  if (bars.length < period + 1) {
    throw new AtrInsufficientDataError(period + 1, bars.length);
  }

  const trs: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const current = bars[i];
    const previous = bars[i - 1];
    if (!current || !previous) throw new Error("unexpected missing bar");
    trs.push(trueRange(current, previous.close));
  }

  let atr = trs.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (const tr of trs.slice(period)) {
    atr = (atr * (period - 1) + tr) / period;
  }
  return { atr, period, barsUsed: bars.length };
}
