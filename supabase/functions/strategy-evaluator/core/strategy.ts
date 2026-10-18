// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import type { Candle } from "./types.ts";

/**
 * Conditional orders: resting instructions that turn into a real okx.intent.v1 open only when a strategy
 * template's two-stage condition fires. Stage one (the setup) arms the order when the market has done the
 * damage the template waits for; stage two (the trigger) is the reversal confirmation that actually buys.
 * Nothing here places orders: the strategy-evaluator Edge Function evaluates these pure functions against
 * confirmed bars and submits through order-submit, so every existing risk gate still applies.
 */

export const STRATEGY_TEMPLATES = ["reversal_long"] as const;
export type StrategyTemplate = (typeof STRATEGY_TEMPLATES)[number];

export const REVERSAL_TRIGGER_KINDS = ["breakout", "strong_close", "engulfing", "hammer"] as const;
export type ReversalTriggerKind = (typeof REVERSAL_TRIGGER_KINDS)[number];

export type ReversalInterval = "1D" | "15m";

/** Mirrors THEME_STOP_CAP_MAX_U in position.ts; duplicated so this module stays dependency-free for web use. */
export const CONDITIONAL_THEME_STOP_CAP_MAX_U = 0.1;

export interface ReversalLongParams {
  /** Bar interval the trigger stage reads. The setup stage always reads daily bars. */
  interval: ReversalInterval;
  /** Daily bars the reference high is taken over. */
  lookbackDays: number;
  /** The capitulation low must sit inside this many most recent daily bars. */
  setupWindowDays: number;
  /** Setup needs the window low at least this percent below the reference high. */
  minDrawdownPct: number;
  rsiLen: number;
  /** Setup also needs the window's lowest daily RSI at or below this. Null disables the RSI gate. */
  rsiMax: number | null;
  /** Any one trigger fires the order. Evaluated in this order. */
  triggers: ReversalTriggerKind[];
  /** strong_close: the bar must gain at least this percent against the previous close. */
  strongClosePct: number;
  /** The stop sits this percent below the setup low; a daily close below it before the trigger invalidates. */
  stopBufferPct: number;
  /** A primed setup older than this is discarded and the order goes back to watching for a fresh one. */
  setupMaxAgeDays: number;
}

export const DEFAULT_REVERSAL_PARAMS: ReversalLongParams = {
  interval: "1D",
  lookbackDays: 30,
  setupWindowDays: 7,
  minDrawdownPct: 10,
  rsiLen: 14,
  rsiMax: 45,
  triggers: ["breakout", "strong_close", "engulfing"],
  strongClosePct: 3,
  stopBufferPct: 1.5,
  setupMaxAgeDays: 10,
};

export class StrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyError";
  }
}

function fail(message: string): never {
  throw new StrategyError(message);
}

function requireObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${what} must be an object`);
  return raw as Record<string, unknown>;
}

function intIn(obj: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = obj[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numIn(obj: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = obj[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${key} must be a number between ${min} and ${max}`);
  }
  return value;
}

/** Validates the JSON `params` column of a conditional order and applies the template defaults. */
export function parseStrategyParams(template: string, raw: unknown): ReversalLongParams {
  if (template !== "reversal_long") fail(`unknown strategy template "${template}"`);
  const obj = raw === undefined || raw === null ? {} : requireObject(raw, "params");
  const d = DEFAULT_REVERSAL_PARAMS;

  const interval = obj.interval ?? d.interval;
  if (interval !== "1D" && interval !== "15m") fail('interval must be "1D" or "15m"');

  const rsiMaxRaw = obj.rsiMax === undefined ? d.rsiMax : obj.rsiMax;
  if (rsiMaxRaw !== null && (typeof rsiMaxRaw !== "number" || !Number.isFinite(rsiMaxRaw) || rsiMaxRaw < 5 || rsiMaxRaw > 70)) {
    fail("rsiMax must be null or a number between 5 and 70");
  }

  let triggers = d.triggers;
  if (obj.triggers !== undefined) {
    if (!Array.isArray(obj.triggers) || obj.triggers.length === 0) fail("triggers must be a non-empty array");
    for (const item of obj.triggers) {
      if (!(REVERSAL_TRIGGER_KINDS as readonly unknown[]).includes(item)) {
        fail(`triggers may only contain ${REVERSAL_TRIGGER_KINDS.join(", ")}`);
      }
    }
    triggers = [...new Set(obj.triggers as ReversalTriggerKind[])];
  }

  return {
    interval: interval as ReversalInterval,
    lookbackDays: intIn(obj, "lookbackDays", d.lookbackDays, 10, 90),
    setupWindowDays: intIn(obj, "setupWindowDays", d.setupWindowDays, 1, 30),
    minDrawdownPct: numIn(obj, "minDrawdownPct", d.minDrawdownPct, 1, 60),
    rsiLen: intIn(obj, "rsiLen", d.rsiLen, 2, 50),
    rsiMax: rsiMaxRaw as number | null,
    triggers,
    strongClosePct: numIn(obj, "strongClosePct", d.strongClosePct, 0.5, 20),
    stopBufferPct: numIn(obj, "stopBufferPct", d.stopBufferPct, 0.1, 10),
    setupMaxAgeDays: intIn(obj, "setupMaxAgeDays", d.setupMaxAgeDays, 1, 30),
  };
}

/** Wilder RSI aligned with `closes`; entries before the first smoothed value are null. */
export function wilderRsi(closes: readonly number[], len: number): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= len) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= len; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta > 0) gain += delta;
    else loss -= delta;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    gain = (gain * (len - 1) + Math.max(delta, 0)) / len;
    loss = (loss * (len - 1) + Math.max(-delta, 0)) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface ReversalSetup {
  /** Lowest low inside the setup window: the capitulation low the stop is anchored to. */
  setupLow: number;
  /** Open time (epoch ms) of the daily bar that made the setup low. */
  setupLowTs: number;
  /** Highest high over the lookback window. */
  refHigh: number;
  drawdownPct: number;
  /** Lowest daily RSI inside the setup window, when the RSI gate is on and defined there. */
  windowMinRsi: number | null;
}

/**
 * Stage one. `daily` is ascending confirmed daily bars. The setup is present when the lowest low of the
 * recent window sits at least minDrawdownPct below the lookback high and, when the RSI gate is on, the
 * window's lowest daily RSI is at or below rsiMax. Returns null while the market has not done enough damage.
 */
export function evaluateReversalSetup(daily: readonly Candle[], params: ReversalLongParams): ReversalSetup | null {
  if (daily.length < params.lookbackDays) return null;
  const lookback = daily.slice(daily.length - params.lookbackDays);
  const window = daily.slice(daily.length - params.setupWindowDays);
  const refHigh = Math.max(...lookback.map((bar) => bar.high));
  if (!(refHigh > 0)) return null;

  let lowBar: Candle | null = null;
  for (const bar of window) {
    if (lowBar === null || bar.low < lowBar.low) lowBar = bar;
  }
  if (lowBar === null) return null;
  const drawdownPct = ((refHigh - lowBar.low) / refHigh) * 100;
  if (drawdownPct < params.minDrawdownPct) return null;

  let windowMinRsi: number | null = null;
  if (params.rsiMax !== null) {
    const rsi = wilderRsi(
      daily.map((bar) => bar.close),
      params.rsiLen,
    );
    const windowStart = daily.length - params.setupWindowDays;
    for (let i = windowStart; i < daily.length; i += 1) {
      const value = rsi[i] ?? null;
      if (value !== null && (windowMinRsi === null || value < windowMinRsi)) windowMinRsi = value;
    }
    if (windowMinRsi === null || windowMinRsi > params.rsiMax) return null;
  }
  return { setupLow: lowBar.low, setupLowTs: lowBar.ts, refHigh, drawdownPct, windowMinRsi };
}

export interface ReversalTrigger {
  kind: ReversalTriggerKind;
  /** Open time (epoch ms) of the confirmed bar that fired. Part of the submit idempotency key. */
  barTs: number;
  /** Close of the firing bar; the entry reference for the take-profit level. */
  close: number;
  /** Highest high of the bars from the setup low up to (excluding) the firing bar. Set for breakout. */
  rangeHigh: number | null;
}

/**
 * Stage two. `bars` is ascending confirmed bars on the trigger interval; only bars at or after the setup
 * low's bar are considered, and the firing bar is always the latest one, so a signal is acted on in the
 * run that first sees its bar confirmed and never replayed later. The setup low bar itself can never fire.
 */
export function evaluateReversalTrigger(
  bars: readonly Candle[],
  params: ReversalLongParams,
  setup: Pick<ReversalSetup, "setupLowTs">,
): ReversalTrigger | null {
  const scoped = bars.filter((bar) => bar.ts >= setup.setupLowTs);
  const last = scoped[scoped.length - 1];
  if (!last || last.ts === setup.setupLowTs) return null;
  const prev = scoped[scoped.length - 2];

  for (const kind of params.triggers) {
    if (kind === "breakout") {
      const prior = scoped.slice(0, scoped.length - 1);
      if (prior.length === 0) continue;
      const rangeHigh = Math.max(...prior.map((bar) => bar.high));
      if (last.close > rangeHigh) return { kind, barTs: last.ts, close: last.close, rangeHigh };
    } else if (kind === "strong_close") {
      if (!prev || !(prev.close > 0) || last.close <= last.open) continue;
      const range = last.high - last.low;
      if (range <= 0) continue;
      const gainPct = ((last.close - prev.close) / prev.close) * 100;
      const closePosition = (last.close - last.low) / range;
      if (gainPct >= params.strongClosePct && closePosition >= 0.7) {
        return { kind, barTs: last.ts, close: last.close, rangeHigh: null };
      }
    } else if (kind === "engulfing") {
      if (!prev) continue;
      if (last.close > last.open && prev.close < prev.open && last.close >= prev.open && last.open <= prev.close) {
        return { kind, barTs: last.ts, close: last.close, rangeHigh: null };
      }
    } else if (kind === "hammer") {
      const range = last.high - last.low;
      if (range <= 0 || last.close <= last.open) continue;
      const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
      if (lowerWick >= 0.6) return { kind, barTs: last.ts, close: last.close, rangeHigh: null };
    }
  }
  return null;
}

/** The stop level implied by a setup: stopBufferPct below the capitulation low. */
export function reversalStopLevel(setupLow: number, stopBufferPct: number): number {
  return setupLow * (1 - stopBufferPct / 100);
}

/**
 * A confirmed daily close below the stop level, on a bar after the setup low bar, breaks this setup before
 * any trigger fired: the "bottom" gave way. The evaluator discards the setup and returns the order to
 * watching, so it can prime again on a deeper capitulation instead of buying the first bounce of a
 * continuing decline. No money is at risk pre-fire; the position's own stop governs after the trigger.
 */
export function evaluateReversalInvalidation(
  daily: readonly Candle[],
  setup: Pick<ReversalSetup, "setupLowTs">,
  stopLevel: number,
): boolean {
  return daily.some((bar) => bar.ts > setup.setupLowTs && bar.close < stopLevel);
}

/** Daily bars the evaluator fetches: lookback plus RSI warmup and slack. */
export function reversalDailyBarsNeeded(params: ReversalLongParams): number {
  return params.lookbackDays + params.rsiLen + 5;
}

export interface ConditionalOrderInput {
  mode: "demo" | "live";
  instId: string;
  template: StrategyTemplate;
  lever: number;
  /** Contract size as a decimal string, exactly as it will be sent to OKX. */
  sz: string;
  tdMode: "isolated" | "cross";
  theme: string;
  themeStopCapU: number;
  tpPct: number | null;
  expiresAt: string;
  params: ReversalLongParams;
  note: string | null;
}

export type ConditionalOrderParse = { ok: true; value: ConditionalOrderInput } | { ok: false; error: string };

const INST_ID = /^[A-Z0-9]+-USDT-SWAP$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_EXPIRY_DAYS = 31;

/**
 * Validates a conditional-order create body (web API shape). Expiry is given as expiresAt (ISO) or
 * expiresInDays; the stored row always carries the absolute expiresAt. Direction is fixed long and
 * posSide net for the reversal template: catching a bottom is a long entry in net mode.
 */
export function parseConditionalOrderInput(input: unknown, nowMs: number): ConditionalOrderParse {
  try {
    const o = requireObject(input, "body");
    const instId = typeof o.instId === "string" ? o.instId : "";
    if (!INST_ID.test(instId)) fail("instId must be a USDT-margined swap, e.g. NVDA-USDT-SWAP");
    const mode = o.mode === undefined || o.mode === null ? "live" : o.mode;
    if (mode !== "demo" && mode !== "live") fail('mode must be "demo" or "live"');
    const template = o.template === undefined || o.template === null ? "reversal_long" : o.template;
    if (!(STRATEGY_TEMPLATES as readonly unknown[]).includes(template)) {
      fail(`template must be one of ${STRATEGY_TEMPLATES.join(", ")}`);
    }
    const lever = o.lever;
    if (typeof lever !== "number" || !Number.isFinite(lever) || lever < 1 || lever > 125) {
      fail("lever must be a number between 1 and 125");
    }
    const szRaw = o.sz;
    const sz = typeof szRaw === "number" ? String(szRaw) : typeof szRaw === "string" ? szRaw.trim() : "";
    if (!DECIMAL.test(sz) || Number(sz) <= 0) fail("sz must be a positive decimal");
    const tdMode = o.tdMode === undefined || o.tdMode === null ? "isolated" : o.tdMode;
    if (tdMode !== "isolated" && tdMode !== "cross") fail('tdMode must be "isolated" or "cross"');
    const theme = o.theme;
    if (typeof theme !== "string" || theme.trim() === "" || theme.length > 64) {
      fail("theme is required (at most 64 characters)");
    }
    const themeStopCapU = o.themeStopCapU;
    if (
      typeof themeStopCapU !== "number" ||
      !Number.isFinite(themeStopCapU) ||
      themeStopCapU <= 0 ||
      themeStopCapU > CONDITIONAL_THEME_STOP_CAP_MAX_U
    ) {
      fail(`themeStopCapU must be a number in (0, ${CONDITIONAL_THEME_STOP_CAP_MAX_U}]`);
    }
    let tpPct: number | null = null;
    if (o.tpPct !== undefined && o.tpPct !== null) {
      if (typeof o.tpPct !== "number" || !Number.isFinite(o.tpPct) || o.tpPct <= 0 || o.tpPct > 200) {
        fail("tpPct must be a number in (0, 200]");
      }
      tpPct = o.tpPct;
    }
    let expiresAt: string;
    if (typeof o.expiresAt === "string" && o.expiresAt !== "") {
      const ms = Date.parse(o.expiresAt);
      if (Number.isNaN(ms)) fail("expiresAt must be an ISO-8601 timestamp");
      if (ms <= nowMs) fail("expiresAt must be in the future");
      if (ms > nowMs + MAX_EXPIRY_DAYS * 86_400_000) fail(`expiresAt must be within ${MAX_EXPIRY_DAYS} days`);
      expiresAt = new Date(ms).toISOString();
    } else {
      const days = o.expiresInDays === undefined || o.expiresInDays === null ? 14 : o.expiresInDays;
      if (typeof days !== "number" || !Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
        fail(`expiresInDays must be a number in (0, ${MAX_EXPIRY_DAYS}]`);
      }
      expiresAt = new Date(nowMs + days * 86_400_000).toISOString();
    }
    const noteRaw = o.note;
    if (noteRaw !== undefined && noteRaw !== null && (typeof noteRaw !== "string" || noteRaw.length > 500)) {
      fail("note must be a string of at most 500 characters");
    }
    return {
      ok: true,
      value: {
        mode: mode as "demo" | "live",
        instId,
        template: template as StrategyTemplate,
        lever,
        sz,
        tdMode: tdMode as "isolated" | "cross",
        theme: theme as string,
        themeStopCapU,
        tpPct,
        expiresAt,
        params: parseStrategyParams(template as string, o.params ?? {}),
        note: typeof noteRaw === "string" && noteRaw !== "" ? noteRaw : null,
      },
    };
  } catch (error) {
    if (error instanceof StrategyError) return { ok: false, error: error.message };
    throw error;
  }
}
