export interface QuoteRow {
  symbol: string;
  price: number | string;
  ts: string;
}

export interface QuoteView {
  symbol: string;
  price: number | null;
  ts: string | null;
}

/** One row per configured symbol, in the configured order. Symbols without a quote get nulls. */
export function buildQuoteBoard(symbols: readonly string[], rows: readonly QuoteRow[]): QuoteView[] {
  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  return symbols.map((symbol) => {
    const row = bySymbol.get(symbol);
    if (!row) return { symbol, price: null, ts: null };
    const price = Number(row.price);
    return { symbol, price: Number.isFinite(price) ? price : null, ts: row.ts };
  });
}

/** Falls back to the first symbol when the requested one is unknown, so the picker never shows nothing. */
export function resolveSelectedSymbol(requested: unknown, symbols: readonly string[]): string | null {
  if (typeof requested === "string" && symbols.includes(requested)) return requested;
  return symbols[0] ?? null;
}

export interface CandleRow {
  ts: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume?: number | string | null;
  confirmed: boolean;
}

export interface CandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  confirmed: boolean;
}

/** Converts PostgREST rows to ascending, de-duplicated, finite bars. Malformed bars are dropped. */
export function toCandleBars(rows: readonly CandleRow[]): CandleBar[] {
  const byTime = new Map<number, CandleBar>();
  for (const row of rows) {
    const time = Date.parse(row.ts);
    const volume = Number(row.volume ?? 0);
    const bar = {
      time,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
      confirmed: row.confirmed,
    };
    const valid =
      Number.isFinite(time) &&
      [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
      bar.high >= bar.low &&
      bar.low > 0;
    if (valid) byTime.set(time, bar);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export interface LatestSummary {
  close: number;
  time: number;
  changePct: number | null;
}

export function summarizeLatest(bars: readonly CandleBar[]): LatestSummary | null {
  const last = bars.at(-1);
  if (!last) return null;
  const previous = bars.at(-2);
  const changePct = previous && previous.close > 0 ? ((last.close - previous.close) / previous.close) * 100 : null;
  return { close: last.close, time: last.time, changePct };
}
