// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import { trueRange, type OhlcBar } from "./atr.ts";

/**
 * Indicator atoms: pure series math over ascending bars. Every function returns a series aligned with
 * its input (same length, same index = same bar) and uses null where the value is not yet defined
 * (warmup), so callers never have to guess offsets. Nothing here reads a clock, a database or the
 * network; the trend evaluator composes these into signal checks, and each one is unit-tested against
 * hand-computed series.
 */

/** A bar with a volume reading. Candle satisfies this structurally. */
export interface VolBar extends OhlcBar {
  open: number;
  volume: number;
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** True ranges aligned with `bars`: index 0 is the bar's own range (no previous close exists). */
export function trueRanges(bars: readonly OhlcBar[]): number[] {
  return bars.map((bar, i) => (i === 0 ? bar.high - bar.low : trueRange(bar, bars[i - 1]!.close)));
}

/**
 * Wilder ATR as a series. The seed sits at index `len`: the simple mean of the true ranges of bars
 * 1..len; every later index applies Wilder smoothing. The last non-null value equals
 * computeAtr(bars, len).atr for the same bars.
 */
export function wilderAtrSeries(bars: readonly OhlcBar[], len: number): (number | null)[] {
  if (!Number.isInteger(len) || len < 1) throw new RangeError("len must be a positive integer");
  const out: (number | null)[] = bars.map(() => null);
  if (bars.length <= len) return out;
  const trs = trueRanges(bars);
  let atr = meanOf(trs.slice(1, len + 1));
  out[len] = atr;
  for (let i = len + 1; i < bars.length; i += 1) {
    atr = (atr * (len - 1) + trs[i]!) / len;
    out[i] = atr;
  }
  return out;
}

/** Simple moving average of `values`; null until `len` values have accumulated. */
export function smaSeries(values: readonly number[], len: number): (number | null)[] {
  if (!Number.isInteger(len) || len < 1) throw new RangeError("len must be a positive integer");
  const out: (number | null)[] = values.map(() => null);
  let windowSum = 0;
  for (let i = 0; i < values.length; i += 1) {
    windowSum += values[i]!;
    if (i >= len) windowSum -= values[i - len]!;
    if (i >= len - 1) out[i] = windowSum / len;
  }
  return out;
}

/**
 * SMA(fastLen) − SMA(slowLen) at each index; null until both averages exist (i.e. before index
 * slowLen − 1 when slowLen > fastLen). Raw price units on purpose: callers normalize by an ATR
 * series to compare spreads across symbols. Positive in an uptrend, negative in a downtrend, and
 * near zero while the averages are tangled.
 */
export function maSpread(values: readonly number[], fastLen: number, slowLen: number): (number | null)[] {
  const fast = smaSeries(values, fastLen);
  const slow = smaSeries(values, slowLen);
  return values.map((_, i) => {
    const f = fast[i]!;
    const s = slow[i]!;
    return f === null || s === null ? null : f - s;
  });
}

/** Highest value of the `len` values strictly before each index; null until `len` priors exist. */
export function rollingMaxSeries(values: readonly number[], len: number): (number | null)[] {
  if (!Number.isInteger(len) || len < 1) throw new RangeError("len must be a positive integer");
  return values.map((_, i) => {
    if (i < len) return null;
    let max = Number.NEGATIVE_INFINITY;
    for (let j = i - len; j < i; j += 1) max = Math.max(max, values[j]!);
    return max;
  });
}

/** Lowest value of the `len` values strictly before each index; null until `len` priors exist. */
export function rollingMinSeries(values: readonly number[], len: number): (number | null)[] {
  if (!Number.isInteger(len) || len < 1) throw new RangeError("len must be a positive integer");
  return values.map((_, i) => {
    if (i < len) return null;
    let min = Number.POSITIVE_INFINITY;
    for (let j = i - len; j < i; j += 1) min = Math.min(min, values[j]!);
    return min;
  });
}

export interface DonchianSeries {
  /** Highest high of the prior `len` bars at each index (the bar itself excluded). */
  upper: (number | null)[];
  /** Lowest low of the prior `len` bars at each index (the bar itself excluded). */
  lower: (number | null)[];
}

/** Donchian channel over prior bars only, so a close beyond the channel is a genuine breakout. */
export function donchianSeries(bars: readonly OhlcBar[], len: number): DonchianSeries {
  return {
    upper: rollingMaxSeries(
      bars.map((bar) => bar.high),
      len,
    ),
    lower: rollingMinSeries(
      bars.map((bar) => bar.low),
      len,
    ),
  };
}

/** Where the close sits inside the bar's range: 0 at the low, 1 at the high. A zero-range bar reads 0.5. */
export function closeLocationValue(bar: OhlcBar): number {
  const range = bar.high - bar.low;
  if (!(range > 0)) return 0.5;
  return (bar.close - bar.low) / range;
}

/**
 * Kaufman efficiency ratio over `len` bars: net displacement divided by the sum of per-bar moves.
 * 1 is a perfectly straight path, 0 is pure chop (or no movement at all). Null until `len` moves exist.
 */
export function efficiencyRatioSeries(closes: readonly number[], len: number): (number | null)[] {
  if (!Number.isInteger(len) || len < 1) throw new RangeError("len must be a positive integer");
  const out: (number | null)[] = closes.map(() => null);
  for (let i = len; i < closes.length; i += 1) {
    let path = 0;
    for (let j = i - len + 1; j <= i; j += 1) path += Math.abs(closes[j]! - closes[j - 1]!);
    out[i] = path === 0 ? 0 : Math.abs(closes[i]! - closes[i - len]!) / path;
  }
  return out;
}

export interface LinearRegression {
  /** Change in value per index step (one bar), from the least-squares fit. */
  slope: number;
  /**
   * Coefficient of determination of the fit: 1 is a perfect straight line. A constant series
   * reads 0 — its slope is 0 and there is no variance for a trend to explain.
   */
  r2: number;
}

/**
 * Least-squares line over `values` with x = 0..n−1. Null when fewer than 2 values exist (a single
 * point has no slope). Raw price units: callers divide the slope by an ATR to compare across
 * symbols and timeframes.
 */
export function linearRegression(values: readonly number[]): LinearRegression | null {
  const n = values.length;
  if (n < 2) return null;
  const meanY = meanOf(values);
  const meanX = (n - 1) / 2;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    sxy += dx * (values[i]! - meanY);
    sxx += dx * dx;
  }
  const slope = sxy / sxx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const dy = values[i]! - meanY;
    const residual = dy - slope * (i - meanX);
    ssRes += residual * residual;
    ssTot += dy * dy;
  }
  const r2 = ssTot === 0 ? 0 : Math.min(1, Math.max(0, 1 - ssRes / ssTot));
  return { slope, r2 };
}

export interface RollingRegression {
  /** Least-squares slope of the trailing `len` values ending at each index; null before index len − 1. */
  slope: (number | null)[];
  /** R² of the same trailing fit at each index; null before index len − 1. */
  r2: (number | null)[];
}

/** Rolling least-squares fit over the trailing `len` values (the window includes the bar itself). */
export function rollingRegressionSlope(values: readonly number[], len: number): RollingRegression {
  if (!Number.isInteger(len) || len < 2) throw new RangeError("len must be an integer of at least 2");
  const slope: (number | null)[] = values.map(() => null);
  const r2: (number | null)[] = values.map(() => null);
  for (let i = len - 1; i < values.length; i += 1) {
    const fit = linearRegression(values.slice(i - len + 1, i + 1));
    if (fit) {
      slope[i] = fit.slope;
      r2[i] = fit.r2;
    }
  }
  return { slope, r2 };
}

/** Mean of the non-null values in series[end-window+1 .. end]; null when the window holds none. */
export function trailingMean(series: readonly (number | null)[], window: number): number | null {
  const slice = series.slice(Math.max(0, series.length - window));
  const values = slice.filter((value): value is number => value !== null);
  return values.length === 0 ? null : meanOf(values);
}

/** Max of the non-null values in series[end-window .. end-1] (strictly before the last); null when none. */
export function trailingMaxPrior(series: readonly (number | null)[], window: number): number | null {
  const prior = series.slice(Math.max(0, series.length - 1 - window), series.length - 1);
  const values = prior.filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}
