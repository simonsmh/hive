import type { CandleBar } from "./mapper";

/** Simple moving average of closes, aligned with the bars; null until the window fills. */
export function smaSeries(bars: readonly CandleBar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(bars.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.close;
    if (i >= period) sum -= bars[i - period]!.close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Price range covering every bar plus any overlay series (moving averages), padded by a
 * fraction of the span so the extremes never touch the pane edge. A flat series still gets
 * a non-zero span. Returns null when there is nothing to draw.
 */
export function priceRange(
  bars: readonly CandleBar[],
  overlays: readonly (readonly (number | null)[])[] = [],
  padRatio = 0.06,
): { min: number; max: number } | null {
  if (bars.length === 0) return null;
  let min = Math.min(...bars.map((b) => b.low));
  let max = Math.max(...bars.map((b) => b.high));
  for (const series of overlays) {
    for (const value of series) {
      if (value === null) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (max === min) {
    const pad = Math.max(Math.abs(max) * 0.005, 1e-9);
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * padRatio;
  return { min: min - pad, max: max + pad };
}

/** Largest bar volume; 0 when the series carries no volume data. */
export function maxVolume(bars: readonly CandleBar[]): number {
  let max = 0;
  for (const bar of bars) if (bar.volume > max) max = bar.volume;
  return max;
}

/** Index of the bar under a pixel offset inside the plot area, clamped to the series. */
export function barIndexAtX(x: number, plotWidth: number, count: number): number {
  if (count <= 0 || plotWidth <= 0) return 0;
  const slot = plotWidth / count;
  const index = Math.floor(x / slot);
  return Math.min(count - 1, Math.max(0, index));
}

/** Signed percent change of one bar against its own open. */
export function barChangePct(bar: CandleBar): number | null {
  if (bar.open <= 0) return null;
  return ((bar.close - bar.open) / bar.open) * 100;
}

/**
 * Folds a live trade price into the tail of the series: updates the forming bar in place,
 * or appends a fresh bar once the price belongs to the next interval bucket. Returns the
 * original array (same reference) when the price is stale or invalid, so callers can use
 * reference equality to skip re-renders.
 */
export function applyLivePrice(
  bars: readonly CandleBar[],
  price: number,
  tsMs: number,
  intervalMs: number,
): readonly CandleBar[] {
  if (bars.length === 0 || !Number.isFinite(price) || price <= 0 || intervalMs <= 0) return bars;
  const last = bars[bars.length - 1]!;
  if (tsMs < last.time) return bars;
  if (tsMs >= last.time + intervalMs) {
    const time = Math.floor(tsMs / intervalMs) * intervalMs;
    if (time <= last.time) return bars;
    const fresh: CandleBar = {
      time,
      open: last.close,
      high: Math.max(last.close, price),
      low: Math.min(last.close, price),
      close: price,
      volume: 0,
      confirmed: false,
    };
    return [...bars, fresh];
  }
  const updated: CandleBar = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  };
  return [...bars.slice(0, -1), updated];
}
