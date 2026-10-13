import { INTERVALS, type Candle, type Interval } from "./types.js";

export const RULE_KINDS = ["price_cross", "candle_close_break", "volume_spike", "long_wick", "pullback"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export type Direction = "above" | "below";
export type WickSide = "upper" | "lower" | "any";

export type RuleParams =
  | { kind: "price_cross"; level: number; direction: Direction }
  | { kind: "candle_close_break"; interval: Interval; level: number; direction: Direction }
  | { kind: "volume_spike"; interval: Interval; multiple: number; lookback: number }
  | { kind: "long_wick"; interval: Interval; minWickRatio: number; side: WickSide }
  | { kind: "pullback"; interval: Interval; lookback: number; minDropPct: number };

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

export function isCooldownActive(lastTriggeredAtMs: number | null, cooldownSeconds: number, nowMs: number): boolean {
  if (lastTriggeredAtMs === null) return false;
  return nowMs - lastTriggeredAtMs < cooldownSeconds * 1000;
}

/** One alert per rule per bar; the unique index on alerts.dedup_key enforces it across workers. */
export function alertDedupKey(ruleId: string, barTs: number): string {
  return `rule:${ruleId}:${barTs}`;
}
