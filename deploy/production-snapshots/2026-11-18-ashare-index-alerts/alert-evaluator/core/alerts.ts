// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import { INTERVALS, type Candle, type Interval } from "./types.ts";

export const RULE_KINDS = [
  "price_cross",
  "candle_close_break",
  "volume_spike",
  "long_wick",
  "pullback",
  "pct_move",
  "ma_cross",
  "retracement",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export type Direction = "above" | "below";
export type WickSide = "upper" | "lower" | "any";
/** Anchor a retracement rule measures from: the window high ("top"), the window low ("bottom"), or either. */
export type RetraceSide = "top" | "bottom" | "both";

export type RuleParams =
  | { kind: "price_cross"; level: number; direction: Direction }
  | { kind: "candle_close_break"; interval: Interval; level: number; direction: Direction }
  | { kind: "volume_spike"; interval: Interval; multiple: number; lookback: number; minMovePct?: number; skipSessionOpenBars?: number }
  | { kind: "long_wick"; interval: Interval; minWickRatio: number; side: WickSide }
  | { kind: "pullback"; interval: Interval; lookback: number; minDropPct: number }
  | { kind: "pct_move"; interval: Interval; lookback: number; minAbsPct: number }
  | { kind: "ma_cross"; period: number; direction: Direction; interval: Interval }
  | { kind: "retracement"; interval: Interval; lookback: number; minRetracePct: number; side: RetraceSide };

const MAX_BAR_LOOKBACK = 500;
/** A rule stops evaluating when its newest confirmed bar is older than this many intervals. */
export const MAX_BAR_AGE_IN_INTERVALS = 3;

const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1H": 3_600_000,
  "1D": 86_400_000,
};

export class AlertRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertRuleError";
  }
}

const DEFAULT_VOLUME_LOOKBACK = 6;
const DEFAULT_PULLBACK_LOOKBACK = 20;
const DEFAULT_WICK_RATIO = 0.6;
const DEFAULT_RETRACEMENT_LOOKBACK = 20;

function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AlertRuleError("rule params must be an object");
  }
  return raw as Record<string, unknown>;
}

function requireFiniteNumber(obj: Record<string, unknown>, key: string, opts: { positive?: boolean } = {}): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AlertRuleError(`${key} must be a finite number`);
  }
  if (opts.positive && value <= 0) throw new AlertRuleError(`${key} must be greater than 0`);
  return value;
}

function optionalInteger(obj: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = obj[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AlertRuleError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requiredInteger(obj: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AlertRuleError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireInterval(obj: Record<string, unknown>): Interval {
  const value = obj.interval;
  if (typeof value !== "string" || !(INTERVALS as readonly string[]).includes(value)) {
    throw new AlertRuleError(`interval must be one of ${INTERVALS.join(", ")}`);
  }
  return value as Interval;
}

function requireDirection(obj: Record<string, unknown>): Direction {
  if (obj.direction !== "above" && obj.direction !== "below") {
    throw new AlertRuleError('direction must be "above" or "below"');
  }
  return obj.direction;
}

function requireRetraceSide(obj: Record<string, unknown>): RetraceSide {
  const value = obj.side ?? "both";
  if (value !== "top" && value !== "bottom" && value !== "both") {
    throw new AlertRuleError('side must be "top", "bottom" or "both"');
  }
  return value;
}

/** Validates the JSON `params` column of an alert rule and applies defaults. */
export function parseRuleParams(kind: string, raw: unknown): RuleParams {
  const obj = requireObject(raw);
  switch (kind) {
    case "price_cross":
      return { kind, level: requireFiniteNumber(obj, "level", { positive: true }), direction: requireDirection(obj) };
    case "candle_close_break":
      return {
        kind,
        interval: requireInterval(obj),
        level: requireFiniteNumber(obj, "level", { positive: true }),
        direction: requireDirection(obj),
      };
    case "volume_spike": {
      const minMovePct = obj.minMovePct;
      if (
        minMovePct !== undefined &&
        (typeof minMovePct !== "number" || !Number.isFinite(minMovePct) || minMovePct < 0)
      ) {
        throw new AlertRuleError("minMovePct must be a finite number >= 0");
      }
      const skipSessionOpenBars = obj.skipSessionOpenBars;
      if (skipSessionOpenBars !== undefined) {
        optionalInteger(obj, "skipSessionOpenBars", 0, 0, 6);
      }
      return {
        kind,
        interval: requireInterval(obj),
        multiple: requireFiniteNumber(obj, "multiple", { positive: true }),
        lookback: optionalInteger(obj, "lookback", DEFAULT_VOLUME_LOOKBACK, 1, 100),
        ...(minMovePct !== undefined ? { minMovePct } : {}),
        ...(skipSessionOpenBars !== undefined ? { skipSessionOpenBars: skipSessionOpenBars as number } : {}),
      };
    }
    case "long_wick": {
      const side = obj.side ?? "any";
      if (side !== "upper" && side !== "lower" && side !== "any") {
        throw new AlertRuleError('side must be "upper", "lower" or "any"');
      }
      const ratio = obj.minWickRatio ?? DEFAULT_WICK_RATIO;
      if (typeof ratio !== "number" || !(ratio > 0 && ratio < 1)) {
        throw new AlertRuleError("minWickRatio must be a number in (0, 1)");
      }
      return { kind, interval: requireInterval(obj), minWickRatio: ratio, side };
    }
    case "pullback":
      return {
        kind,
        interval: requireInterval(obj),
        lookback: optionalInteger(obj, "lookback", DEFAULT_PULLBACK_LOOKBACK, 2, 500),
        minDropPct: requireFiniteNumber(obj, "minDropPct", { positive: true }),
      };
    case "pct_move":
      return {
        kind,
        interval: requireInterval(obj),
        lookback: requiredInteger(obj, "lookback", 1, MAX_BAR_LOOKBACK),
        minAbsPct: requireFiniteNumber(obj, "minAbsPct", { positive: true }),
      };
    case "ma_cross":
      return {
        kind,
        period: optionalInteger(obj, "period", 5, 1, MAX_BAR_LOOKBACK),
        direction: obj.direction === undefined ? "above" : requireDirection(obj),
        interval: obj.interval === undefined ? "5m" : requireInterval(obj),
      };
    case "retracement":
      return {
        kind,
        interval: requireInterval(obj),
        lookback: optionalInteger(obj, "lookback", DEFAULT_RETRACEMENT_LOOKBACK, 2, MAX_BAR_LOOKBACK),
        minRetracePct: requireFiniteNumber(obj, "minRetracePct", { positive: true }),
        side: requireRetraceSide(obj),
      };
    default:
      throw new AlertRuleError(`unknown rule kind "${kind}"`);
  }
}

/** Fires once when the price moves from one side of `level` to the other. */
export function evaluatePriceCross(
  params: Extract<RuleParams, { kind: "price_cross" }>,
  previousPrice: number | null,
  lastPrice: number,
): boolean {
  if (previousPrice === null) return false;
  if (params.direction === "above") return previousPrice < params.level && lastPrice >= params.level;
  return previousPrice > params.level && lastPrice <= params.level;
}

/** Last confirmed bar closes beyond `level`. `candles` must be ascending and confirmed-only. */
export function evaluateCandleCloseBreak(
  params: Extract<RuleParams, { kind: "candle_close_break" }>,
  candles: readonly Candle[],
): boolean {
  const last = candles[candles.length - 1];
  if (!last) return false;
  return params.direction === "above" ? last.close > params.level : last.close < params.level;
}

/**
 * Latest bar volume as a multiple of the average of the `lookback` bars before it: the ratio the rule is
 * actually measuring against its threshold. Null when the window is too short or the baseline is zero, so a
 * caller never reports a fabricated ratio.
 */
export function observedVolumeMultiple(
  params: Pick<Extract<RuleParams, { kind: "volume_spike" }>, "lookback">,
  candles: readonly Candle[],
): number | null {
  if (candles.length < params.lookback + 1) return null;
  const last = candles[candles.length - 1];
  if (!last) return null;
  const prior = candles.slice(candles.length - 1 - params.lookback, candles.length - 1);
  const avg = prior.reduce((sum, c) => sum + c.volume, 0) / prior.length;
  if (!(avg > 0)) return null;
  return last.volume / avg;
}

/** Latest bar volume is at least `multiple` times the average of the `lookback` bars before it.
 * When `minMovePct` is set, the latest bar's own |close - open| move must also reach it, so a
 * volume burst with no price move does not fire.
 * When `skipSessionOpenBars` is set, the first N A-share session bars (starting 09:30 Asia/Shanghai)
 * never fire: the open bar is routinely several times the previous afternoon average even without
 * a genuine intraday burst. Lunch 13:00 is not skipped; Sina 5m volume is per-bar, not cumulative. */
export function evaluateVolumeSpike(
  params: Extract<RuleParams, { kind: "volume_spike" }>,
  candles: readonly Candle[],
): boolean {
  if (candles.length < params.lookback + 1) return false;
  const last = candles[candles.length - 1];
  if (!last) return false;
  if (isSessionOpenSkipBar(last.ts, params.interval, params.skipSessionOpenBars ?? 0)) return false;
  const observed = observedVolumeMultiple(params, candles);
  if (observed === null) return false;
  if (observed < params.multiple) return false;
  if (params.minMovePct !== undefined) {
    if (!(last.open > 0)) return false;
    const movePct = (Math.abs(last.close - last.open) / last.open) * 100;
    if (movePct < params.minMovePct) return false;
  }
  return true;
}

/** Latest bar has a wick of at least `minWickRatio` of its full range on the requested side. */
export function evaluateLongWick(params: Extract<RuleParams, { kind: "long_wick" }>, candles: readonly Candle[]): boolean {
  const last = candles[candles.length - 1];
  if (!last) return false;
  const range = last.high - last.low;
  if (range <= 0) return false;
  const bodyTop = Math.max(last.open, last.close);
  const bodyBottom = Math.min(last.open, last.close);
  const upper = (last.high - bodyTop) / range;
  const lower = (bodyBottom - last.low) / range;
  if (params.side === "upper") return upper >= params.minWickRatio;
  if (params.side === "lower") return lower >= params.minWickRatio;
  return upper >= params.minWickRatio || lower >= params.minWickRatio;
}

/**
 * Last close is at least `minDropPct` percent below the highest high of the
 * trailing `lookback` bars (including the latest bar).
 */
export function evaluatePullback(params: Extract<RuleParams, { kind: "pullback" }>, candles: readonly Candle[]): boolean {
  if (candles.length < params.lookback) return false;
  const window = candles.slice(candles.length - params.lookback);
  const peak = Math.max(...window.map((c) => c.high));
  const last = window[window.length - 1];
  if (!last || peak <= 0) return false;
  const dropPct = ((peak - last.close) / peak) * 100;
  return dropPct >= params.minDropPct;
}

export interface PercentMove {
  earlier: number;
  last: number;
  /** Signed: (last - earlier) / earlier * 100. */
  pct: number;
}

/**
 * Change of the latest close against the close `lookback` bars earlier. `candles` must be ascending and
 * confirmed-only, so the latest bar is the last confirmed one. Null when fewer than lookback + 1 bars are
 * available or the earlier close is not positive, since the percentage is undefined then.
 */
export function percentMove(lookback: number, candles: readonly Candle[]): PercentMove | null {
  if (candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1];
  const earlier = candles[candles.length - 1 - lookback];
  if (!last || !earlier || !(earlier.close > 0)) return null;
  return { earlier: earlier.close, last: last.close, pct: ((last.close - earlier.close) / earlier.close) * 100 };
}

/** Fires when the absolute move over the lookback is at least `minAbsPct` percent. */
export function evaluatePctMove(params: Extract<RuleParams, { kind: "pct_move" }>, candles: readonly Candle[]): boolean {
  const move = percentMove(params.lookback, candles);
  return move !== null && Math.abs(move.pct) >= params.minAbsPct;
}

/** Minutes since midnight in Asia/Shanghai. China has no daylight saving, so a fixed +8h offset is exact. */
function shanghaiMinutes(ts: number): number {
  const shifted = new Date(ts + 8 * 3_600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** A-share cash session opens at 09:30 Asia/Shanghai. `skipCount` is how many opening bars to ignore,
 * in the rule's own interval (1 = the 09:30 bar only). 1D rules and a skip of 0 never skip. */
export function isSessionOpenSkipBar(barTs: number, interval: Interval, skipCount: number): boolean {
  if (skipCount <= 0 || interval === "1D") return false;
  const stepMinutes = INTERVAL_MS[interval] / 60_000;
  if (!Number.isInteger(stepMinutes) || stepMinutes <= 0) return false;
  const minutes = shanghaiMinutes(barTs);
  const open = 9 * 60 + 30;
  for (let i = 0; i < skipCount; i += 1) {
    if (minutes === open + i * stepMinutes) return true;
  }
  return false;
}

/** Calendar date ("YYYY-MM-DD") in Asia/Shanghai. Fixed +8h offset, as above. */
function shanghaiDateKey(ts: number): string {
  const shifted = new Date(ts + 8 * 3_600_000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/**
 * A-shares trade 09:30-11:30 and 13:00-15:00 Beijing, so the last 5m bar of the day opens at 14:55. A trigger
 * on that bar is the close confirmation; any earlier bar is provisional and may be undone before the close.
 */
export function isCloseConfirmationBar(barTs: number): boolean {
  return shanghaiMinutes(barTs) === 14 * 60 + 55;
}

/**
 * Latest confirmed intraday bar closes across the moving average of the last `period` completed daily closes.
 * `candles` are the intraday series (ascending, confirmed-only) on params.interval; `dailyCloses` are the daily
 * closes (ascending) from the same source's 1D series. The average is recalculated every day from the daily
 * series, never from a fixed reference line:
 * - Provisional bars use the last `period` daily closes. During trading hours the daily bar for the current
 *   day is not written yet, so this is the average through yesterday's close.
 * - The 14:55 close-confirmation bar uses the last `period - 1` daily closes dated before today plus the
 *   bar's own close as today's close, so the reclaim is judged against the MA of the day that just closed.
 *   Daily closes dated today are excluded from the prior window, so the value is identical whether the daily
 *   collector has already written today's bar or not. The previous intraday bar must sit on or below the
 *   average for direction "above" (on or above it for "below"), so a bar that merely stays above the average
 *   does not refire. Null when fewer than two intraday bars are available or the average cannot be formed.
 */
export function evaluateMaCross(
  params: Extract<RuleParams, { kind: "ma_cross" }>,
  candles: readonly Candle[],
  dailyCloses: readonly Candle[],
): RuleEvaluation | null {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1]!;
  const previous = candles[candles.length - 2]!;
  let ma: number;
  if (isCloseConfirmationBar(last.ts)) {
    const priorCount = params.period - 1;
    const prior =
      priorCount === 0
        ? []
        : dailyCloses
            .filter((c) => shanghaiDateKey(c.ts) < shanghaiDateKey(last.ts))
            .slice(-priorCount);
    if (prior.length < priorCount) return null;
    ma = (prior.reduce((sum, c) => sum + c.close, 0) + last.close) / params.period;
  } else {
    if (dailyCloses.length < params.period) return null;
    const window = dailyCloses.slice(dailyCloses.length - params.period);
    ma = window.reduce((sum, c) => sum + c.close, 0) / window.length;
  }
  if (!(ma > 0)) return null;
  const crossed =
    params.direction === "above" ? previous.close <= ma && last.close > ma : previous.close >= ma && last.close < ma;
  if (!crossed) return null;
  return {
    barTs: last.ts,
    details: {
      ma: round4(ma),
      last_price: last.close,
      previous_price: previous.close,
      period: params.period,
      close_confirmation: isCloseConfirmationBar(last.ts) ? 1 : 0,
    },
  };
}

/**
 * Turning-point signal. The anchor is the highest high of the trailing `lookback` bars (top) or their lowest
 * low (bottom); the anchor bar itself is excluded, so the latest close is always compared with an earlier
 * extreme and a new high or low simply moves the anchor instead of firing. The rule fires when the latest
 * close has already given back `minRetracePct` percent from that anchor, measured against the anchor price:
 * (anchor - close) / anchor * 100 for a top, (close - anchor) / anchor * 100 for a bottom. Only a retracement
 * that is still in force fires, so the bar that merely holds the high (or low) does not. `side` limits the
 * direction; "both" reports whichever anchor is confirmed on the latest bar. A bar that satisfies both (a very
 * wide bar) reports the larger deviation. `candles` must be ascending and confirmed-only. Null when fewer than
 * lookback + 1 bars are available or the trigger price is not positive.
 *
 * Edge-triggered, not level-triggered: a leg fires once, on the first bar whose close crosses the threshold.
 * When the previous bar's close already satisfies the same side against the same anchors, this bar continues
 * that leg and does not fire. Without this, a retracement that persists for hours would re-fire on every
 * cooldown expiry (a 30-minute metronome of identical alerts). The cooldown stays only as a backstop: a
 * genuinely new leg whose first bar lands inside the previous fire's cooldown window is still skipped, and
 * its continuation bars are then suppressed as the same leg.
 */
export function evaluateRetracement(
  params: Extract<RuleParams, { kind: "retracement" }>,
  candles: readonly Candle[],
): RuleEvaluation | null {
  if (candles.length < params.lookback + 1) return null;
  const last = candles[candles.length - 1];
  if (!last || !(last.close > 0)) return null;
  const window = candles.slice(candles.length - 1 - params.lookback, candles.length - 1);
  const anchorHigh = Math.max(...window.map((c) => c.high));
  const anchorLow = Math.min(...window.map((c) => c.low));
  const candidates: { side: "top" | "bottom"; anchor: number; pct: number }[] = [];
  if (params.side !== "bottom" && anchorHigh > 0) {
    const pct = ((anchorHigh - last.close) / anchorHigh) * 100;
    if (pct >= params.minRetracePct) candidates.push({ side: "top", anchor: anchorHigh, pct });
  }
  if (params.side !== "top" && anchorLow > 0) {
    const pct = ((last.close - anchorLow) / anchorLow) * 100;
    if (pct >= params.minRetracePct) candidates.push({ side: "bottom", anchor: anchorLow, pct });
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b.pct > a.pct ? b : a));
  // Continuation of the same leg: the previous bar's close already sits past the threshold on this side
  // against the same anchors, so this bar starts nothing new.
  const prev = candles[candles.length - 2];
  if (prev) {
    if (best.side === "top" && anchorHigh > 0) {
      if (((anchorHigh - prev.close) / anchorHigh) * 100 >= params.minRetracePct) return null;
    }
    if (best.side === "bottom" && anchorLow > 0) {
      if (((prev.close - anchorLow) / anchorLow) * 100 >= params.minRetracePct) return null;
    }
  }
  return {
    barTs: last.ts,
    details: {
      // 1 = suspected top (retraced down from the high), 0 = suspected bottom (rebounded off the low). The
      // payload keeps a numeric field only; the direction text lives in the message formatter.
      is_top: best.side === "top" ? 1 : 0,
      last_price: last.close,
      anchor_price: round4(best.anchor),
      retrace_pct: round4(best.pct),
      lookback: params.lookback,
      min_retrace_pct: params.minRetracePct,
    },
  };
}

/**
 * Interval whose confirmed bars a rule reads. price_cross has no interval parameter, so it compares the two
 * latest 1m closes.
 */
export function ruleInterval(params: RuleParams): Interval {
  return params.kind === "price_cross" ? "1m" : params.interval;
}

/** Number of confirmed bars the evaluator needs for a rule (the most recent bars, ascending). */
export function ruleBarsNeeded(params: RuleParams): number {
  switch (params.kind) {
    case "price_cross":
      return 2;
    case "candle_close_break":
    case "long_wick":
      return 1;
    case "volume_spike":
    case "pct_move":
      return params.lookback + 1;
    case "pullback":
      return params.lookback;
    case "ma_cross":
      return 2;
    case "retracement":
      // lookback anchor bars plus the bar being judged against them.
      return params.lookback + 1;
  }
}

/** A bar is fresh while it is no older than MAX_BAR_AGE_IN_INTERVALS intervals; a stalled collector stops alerts. */
export function isFreshBar(barTs: number, interval: Interval, nowMs: number): boolean {
  return nowMs - barTs <= MAX_BAR_AGE_IN_INTERVALS * INTERVAL_MS[interval];
}

export interface RuleEvaluation {
  /** Open time (epoch ms) of the confirmed bar that triggered the rule. Part of the dedup key. */
  barTs: number;
  /** Numeric values for alerts.payload, snake_case to match the other alert payloads. */
  details: Record<string, number>;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Evaluates any rule against its confirmed candles, ascending, fetched on ruleInterval(params). Returns the
 * triggering bar and the payload values when the rule fires, otherwise null. ma_cross rules additionally need
 * `dailyCloses`, the ascending daily closes from the same source's 1D series (see evaluateMaCross); without
 * enough daily closes they never fire.
 */
export function evaluateRule(
  params: RuleParams,
  candles: readonly Candle[],
  dailyCloses: readonly Candle[] = [],
): RuleEvaluation | null {
  const last = candles[candles.length - 1];
  if (!last) return null;
  const barTs = last.ts;

  switch (params.kind) {
    case "price_cross": {
      const previous = candles[candles.length - 2];
      if (!previous || !evaluatePriceCross(params, previous.close, last.close)) return null;
      return { barTs, details: { last_price: last.close, previous_price: previous.close, level: params.level } };
    }
    case "candle_close_break":
      if (!evaluateCandleCloseBreak(params, candles)) return null;
      return { barTs, details: { last_price: last.close, level: params.level } };
    case "volume_spike": {
      if (!evaluateVolumeSpike(params, candles)) return null;
      // The predicate re-reads the same window; keep one measurement so the reported ratio is exactly the
      // one the rule compared against its threshold.
      const observed = observedVolumeMultiple(params, candles);
      return {
        barTs,
        details: {
          last_price: last.close,
          last_volume: last.volume,
          // Measured ratio (latest volume over the trailing average); never the rule threshold, which is
          // reported separately below.
          ...(observed === null ? {} : { observed_multiple: round4(observed) }),
          /** Rule threshold the measured ratio is compared against. */
          multiple: params.multiple,
          lookback: params.lookback,
          bar_move_pct:
            last.open > 0 ? round4((Math.abs(last.close - last.open) / last.open) * 100) : 0,
        },
      };
    }
    case "long_wick":
      if (!evaluateLongWick(params, candles)) return null;
      return { barTs, details: { last_price: last.close } };
    case "pullback":
      if (!evaluatePullback(params, candles)) return null;
      return { barTs, details: { last_price: last.close, min_drop_pct: params.minDropPct } };
    case "pct_move": {
      const move = percentMove(params.lookback, candles);
      if (move === null || Math.abs(move.pct) < params.minAbsPct) return null;
      return {
        barTs,
        details: {
          last_price: move.last,
          earlier_price: move.earlier,
          pct: round4(move.pct),
          lookback: params.lookback,
          min_abs_pct: params.minAbsPct,
        },
      };
    }
    case "ma_cross":
      return evaluateMaCross(params, candles, dailyCloses);
    case "retracement":
      return evaluateRetracement(params, candles);
  }
}

export function isCooldownActive(lastTriggeredAtMs: number | null, cooldownSeconds: number, nowMs: number): boolean {
  if (lastTriggeredAtMs === null) return false;
  return nowMs - lastTriggeredAtMs < cooldownSeconds * 1000;
}

/** One alert per rule per bar; the unique index on alerts.dedup_key enforces it across workers. */
export function alertDedupKey(ruleId: string, barTs: number): string {
  return `rule:${ruleId}:${barTs}`;
}
