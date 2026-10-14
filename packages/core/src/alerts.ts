import { INTERVALS, type Candle, type Interval } from "./types.js";

export const RULE_KINDS = [
  "price_cross",
  "candle_close_break",
  "volume_spike",
  "long_wick",
  "pullback",
  "pct_move",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export type Direction = "above" | "below";
export type WickSide = "upper" | "lower" | "any";

export type RuleParams =
  | { kind: "price_cross"; level: number; direction: Direction }
  | { kind: "candle_close_break"; interval: Interval; level: number; direction: Direction }
  | { kind: "volume_spike"; interval: Interval; multiple: number; lookback: number }
  | { kind: "long_wick"; interval: Interval; minWickRatio: number; side: WickSide }
  | { kind: "pullback"; interval: Interval; lookback: number; minDropPct: number }
  | { kind: "pct_move"; interval: Interval; lookback: number; minAbsPct: number };

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
    case "volume_spike":
      return {
        kind,
        interval: requireInterval(obj),
        multiple: requireFiniteNumber(obj, "multiple", { positive: true }),
        lookback: optionalInteger(obj, "lookback", DEFAULT_VOLUME_LOOKBACK, 1, 100),
      };
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

/** Latest bar volume is at least `multiple` times the average of the `lookback` bars before it. */
export function evaluateVolumeSpike(
  params: Extract<RuleParams, { kind: "volume_spike" }>,
  candles: readonly Candle[],
): boolean {
  if (candles.length < params.lookback + 1) return false;
  const last = candles[candles.length - 1];
  if (!last) return false;
  const prior = candles.slice(candles.length - 1 - params.lookback, candles.length - 1);
  const avg = prior.reduce((sum, c) => sum + c.volume, 0) / prior.length;
  if (avg <= 0) return false;
  return last.volume >= params.multiple * avg;
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
 * triggering bar and the payload values when the rule fires, otherwise null.
 */
export function evaluateRule(params: RuleParams, candles: readonly Candle[]): RuleEvaluation | null {
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
    case "volume_spike":
      if (!evaluateVolumeSpike(params, candles)) return null;
      return { barTs, details: { last_price: last.close, last_volume: last.volume, multiple: params.multiple } };
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
