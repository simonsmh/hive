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
  confirmed: boolean;
}

export interface CandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  confirmed: boolean;
}

/** Converts PostgREST rows to ascending, de-duplicated, finite bars. Malformed bars are dropped. */
export function toCandleBars(rows: readonly CandleRow[]): CandleBar[] {
  const byTime = new Map<number, CandleBar>();
  for (const row of rows) {
    const time = Date.parse(row.ts);
    const bar = {
      time,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
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

export interface CandleGlyph {
  x: number;
  bodyTop: number;
  bodyHeight: number;
  wickTop: number;
  wickBottom: number;
  up: boolean;
}

export interface CandleGeometry {
  width: number;
  height: number;
  bodyWidth: number;
  priceMin: number;
  priceMax: number;
  glyphs: CandleGlyph[];
}

/** Maps bars to SVG coordinates. The price axis is padded so the highest high and lowest low stay inside the viewport. */
export function buildCandleGeometry(bars: readonly CandleBar[], width: number, height: number, padding = 8): CandleGeometry | null {
  if (bars.length === 0) return null;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  let priceMin = Math.min(...bars.map((b) => b.low));
  let priceMax = Math.max(...bars.map((b) => b.high));
  if (priceMax === priceMin) {
    const pad = Math.max(Math.abs(priceMax) * 0.005, 1e-9);
    priceMin -= pad;
    priceMax += pad;
  }
  const span = priceMax - priceMin;
  const slot = innerWidth / bars.length;
  const bodyWidth = Math.min(14, Math.max(1, slot * 0.6));
  const toY = (price: number) => padding + ((priceMax - price) / span) * innerHeight;

  const glyphs = bars.map((bar, index): CandleGlyph => {
    const bodyTop = toY(Math.max(bar.open, bar.close));
    const bodyBottom = toY(Math.min(bar.open, bar.close));
    return {
      x: padding + (index + 0.5) * slot,
      bodyTop,
      bodyHeight: Math.max(1, bodyBottom - bodyTop),
      wickTop: toY(bar.high),
      wickBottom: toY(bar.low),
      up: bar.close >= bar.open,
    };
  });

  return { width, height, bodyWidth, priceMin, priceMax, glyphs };
}
