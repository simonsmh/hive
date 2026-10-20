// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import {
  closeLocationValue,
  donchianSeries,
  efficiencyRatioSeries,
  smaSeries,
  trailingMaxPrior,
  trailingMean,
  trueRanges,
  wilderAtrSeries,
} from "./indicators.ts";
import type { Candle } from "./types.ts";

/**
 * trend_follow: a hosted trend-following strategy. An armed instance waits for a fully mechanical
 * entry — volatility expanding, a fat trigger bar closing at its directional extreme, a Donchian
 * breakout, volume and peer confirmation, inside a trend regime — then the evaluator opens through
 * order-submit, pyramids in fixed ATR steps while a single unified stop keeps the whole position's
 * worst-case loss inside the theme cap, and exits when volatility decays from its peak or price closes
 * back through the slow MA. Every decision below is a pure function of bars and stored state, so the
 * Edge Function only does I/O and each rule is unit-tested on its own.
 *
 * This module deliberately stays free of position.ts (which imports node:crypto): the web app imports
 * the parse functions from @hive/core, mirroring strategy.ts. The few step/format helpers are small
 * duplicates of position.ts math and must agree with it.
 */

export type TrendDirection = "long" | "short";
export type TrendRunMode = "shadow" | "live";
export type TrendAccountMode = "demo" | "live";

/** Mirrors THEME_STOP_CAP_MAX_U in position.ts; duplicated so this module stays dependency-free for web use. */
export const TREND_THEME_STOP_CAP_MAX_U = 0.1;

/** The one bar interval the trend evaluator reads. Params carry it so a future template can widen it. */
export const TREND_INTERVAL = "5m" as const;
export const TREND_BAR_MS = 300_000;

export interface TrendParams {
  atrLen: number;
  /** ATR must be the highest of the last this many ATR readings (including itself) to count as expanding. */
  expansionWindow: number;
  /** ...and at least this multiple of the window's mean ATR. */
  expansionMultiple: number;
  donchianLen: number;
  volumeLen: number;
  volumeMultiple: number;
  /** The trigger bar's true range must reach this multiple of ATR. */
  triggerTrMultiple: number;
  /** The close must sit within this fraction of the trigger bar's directional extreme (0.25 = top/bottom quartile). */
  clvBand: number;
  erLen: number;
  /** Kaufman efficiency ratio at or above this counts as a trend regime. */
  erMin: number;
  /** Peer instruments whose same-direction breakouts confirm the signal (self excluded). */
  peerInstIds: string[];
  /** At least this many peers must break out on their latest bar. 0 disables the peer gate. */
  peerMinCount: number;
  /** Favourable excursion, in ATR units from the last fill anchor, that plans one more unit. */
  addStepAtr: number;
  maxAdds: number;
  /** Exit when ATR falls at least this percent below its peak since entry. */
  atrDecayExitPct: number;
  maExitLen: number;
  /** The stop sits this many ATR beyond the base edge (breakout level at entry, add bar's far edge on adds). */
  stopBufferAtr: number;
}

export const DEFAULT_TREND_PARAMS: TrendParams = {
  atrLen: 14,
  expansionWindow: 36,
  expansionMultiple: 1.25,
  donchianLen: 20,
  volumeLen: 20,
  volumeMultiple: 1.5,
  triggerTrMultiple: 2,
  clvBand: 0.25,
  erLen: 10,
  erMin: 0.3,
  peerInstIds: [],
  peerMinCount: 0,
  addStepAtr: 0.5,
  maxAdds: 3,
  atrDecayExitPct: 28,
  maExitLen: 60,
  stopBufferAtr: 0.5,
};

export class TrendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrendError";
  }
}

function fail(message: string): never {
  throw new TrendError(message);
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

const INST_ID = /^[A-Z0-9]+-USDT-SWAP$/;

/** Validates the JSON `params` column of a trend strategy and applies the defaults. */
export function parseTrendParams(raw: unknown): TrendParams {
  const obj = raw === undefined || raw === null ? {} : requireObject(raw, "params");
  const d = DEFAULT_TREND_PARAMS;

  let peerInstIds = d.peerInstIds;
  if (obj.peerInstIds !== undefined) {
    if (!Array.isArray(obj.peerInstIds) || obj.peerInstIds.length > 10) {
      fail("peerInstIds must be an array of at most 10 instrument ids");
    }
    for (const item of obj.peerInstIds) {
      if (typeof item !== "string" || !INST_ID.test(item)) {
        fail("peerInstIds entries must be USDT-margined swaps, e.g. QQQ-USDT-SWAP");
      }
    }
    peerInstIds = [...new Set(obj.peerInstIds as string[])];
  }
  const peerMinCount = intIn(obj, "peerMinCount", d.peerMinCount, 0, 10);
  if (peerMinCount > peerInstIds.length) {
    fail("peerMinCount cannot exceed the number of peerInstIds");
  }

  return {
    atrLen: intIn(obj, "atrLen", d.atrLen, 2, 50),
    expansionWindow: intIn(obj, "expansionWindow", d.expansionWindow, 2, 200),
    expansionMultiple: numIn(obj, "expansionMultiple", d.expansionMultiple, 1, 3),
    donchianLen: intIn(obj, "donchianLen", d.donchianLen, 2, 100),
    volumeLen: intIn(obj, "volumeLen", d.volumeLen, 2, 100),
    volumeMultiple: numIn(obj, "volumeMultiple", d.volumeMultiple, 1, 5),
    triggerTrMultiple: numIn(obj, "triggerTrMultiple", d.triggerTrMultiple, 1, 5),
    clvBand: numIn(obj, "clvBand", d.clvBand, 0.05, 0.5),
    erLen: intIn(obj, "erLen", d.erLen, 2, 50),
    erMin: numIn(obj, "erMin", d.erMin, 0, 1),
    peerInstIds,
    peerMinCount,
    addStepAtr: numIn(obj, "addStepAtr", d.addStepAtr, 0.1, 3),
    maxAdds: intIn(obj, "maxAdds", d.maxAdds, 0, 10),
    atrDecayExitPct: numIn(obj, "atrDecayExitPct", d.atrDecayExitPct, 5, 90),
    maExitLen: intIn(obj, "maExitLen", d.maExitLen, 2, 200),
    stopBufferAtr: numIn(obj, "stopBufferAtr", d.stopBufferAtr, 0.05, 3),
  };
}

/** Confirmed 5m bars the evaluator fetches: enough warmup for every series plus slack. */
export function trendBarsNeeded(params: TrendParams): number {
  const warmup = Math.max(
    params.atrLen + params.expansionWindow,
    params.donchianLen + 1,
    params.volumeLen + 1,
    params.maExitLen,
    params.erLen + 1,
  );
  return warmup + 20;
}

function dirSign(direction: TrendDirection): 1 | -1 {
  return direction === "long" ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Signal atoms. Each returns its measurements alongside the verdict so the
// evaluator can log exactly which gate failed without recomputing anything.
// ---------------------------------------------------------------------------

export interface AtrExpansionCheck {
  pass: boolean;
  atr: number | null;
  /** Highest ATR among the `expansionWindow` readings before the current one. */
  priorMax: number | null;
  /** Mean ATR over the last `expansionWindow` readings including the current one. */
  windowMean: number | null;
}

/** Volatility is expanding when the current ATR makes a window high and clears the scaled window mean. */
export function checkAtrExpansion(
  atrSeries: readonly (number | null)[],
  params: Pick<TrendParams, "expansionWindow" | "expansionMultiple">,
): AtrExpansionCheck {
  const atr = atrSeries[atrSeries.length - 1] ?? null;
  const priorMax = trailingMaxPrior(atrSeries, params.expansionWindow);
  const windowMean = trailingMean(atrSeries, params.expansionWindow);
  const pass =
    atr !== null &&
    priorMax !== null &&
    windowMean !== null &&
    atr >= priorMax &&
    atr >= params.expansionMultiple * windowMean;
  return { pass, atr, priorMax, windowMean };
}

export interface TriggerBarCheck {
  pass: boolean;
  tr: number | null;
  clv: number | null;
}

/** The firing bar must be fat (TR at least triggerTrMultiple x ATR) and close at its directional extreme. */
export function checkTriggerBar(
  bars: readonly Candle[],
  atr: number | null,
  direction: TrendDirection,
  params: Pick<TrendParams, "triggerTrMultiple" | "clvBand">,
): TriggerBarCheck {
  const last = bars[bars.length - 1];
  if (!last || atr === null || !(atr > 0) || bars.length < 2) return { pass: false, tr: null, clv: null };
  const tr = trueRanges(bars)[bars.length - 1]!;
  const clv = closeLocationValue(last);
  const fatEnough = tr >= params.triggerTrMultiple * atr;
  const atExtreme = direction === "long" ? clv >= 1 - params.clvBand : clv <= params.clvBand;
  return { pass: fatEnough && atExtreme, tr, clv };
}

export interface BreakoutCheck {
  pass: boolean;
  /** The channel edge the close had to cross (upper for long, lower for short). */
  level: number | null;
  close: number | null;
}

/** A breakout is the latest close beyond the prior Donchian channel edge for the direction. */
export function checkBreakout(
  bars: readonly Candle[],
  direction: TrendDirection,
  params: Pick<TrendParams, "donchianLen">,
): BreakoutCheck {
  const last = bars[bars.length - 1];
  if (!last) return { pass: false, level: null, close: null };
  const channel = donchianSeries(bars, params.donchianLen);
  const level = direction === "long" ? channel.upper[channel.upper.length - 1]! : channel.lower[channel.lower.length - 1]!;
  if (level === null) return { pass: false, level: null, close: last.close };
  const pass = direction === "long" ? last.close > level : last.close < level;
  return { pass, level, close: last.close };
}

export interface VolumeCheck {
  pass: boolean;
  volume: number | null;
  /** Mean volume of the `volumeLen` bars before the latest one. */
  meanPrior: number | null;
}

/** The firing bar's volume must clear volumeMultiple times the mean of the bars before it. */
export function checkVolume(
  bars: readonly Candle[],
  params: Pick<TrendParams, "volumeLen" | "volumeMultiple">,
): VolumeCheck {
  const last = bars[bars.length - 1];
  if (!last || bars.length <= params.volumeLen) return { pass: false, volume: last?.volume ?? null, meanPrior: null };
  const prior = bars.slice(bars.length - 1 - params.volumeLen, bars.length - 1);
  const meanPrior = prior.reduce((sum, bar) => sum + bar.volume, 0) / prior.length;
  return { pass: meanPrior > 0 && last.volume >= params.volumeMultiple * meanPrior, volume: last.volume, meanPrior };
}

/**
 * How many peer series break out in the strategy's direction on their own latest bar. A peer only
 * confirms when its newest bar is the primary series' newest bar (`asOfTs`): a peer whose feed has
 * stalled still has a "latest" bar, and an hours-old breakout must not satisfy a live entry gate.
 */
export function countPeerConfirmations(
  peerBars: readonly (readonly Candle[])[],
  direction: TrendDirection,
  params: Pick<TrendParams, "donchianLen">,
  asOfTs: number | null,
): number {
  let count = 0;
  for (const series of peerBars) {
    const last = series[series.length - 1];
    if (!last || asOfTs === null || last.ts !== asOfTs) continue;
    if (checkBreakout(series, direction, params).pass) count += 1;
  }
  return count;
}

export interface RegimeCheck {
  pass: boolean;
  er: number | null;
}

/** The regime gate: Kaufman efficiency ratio over erLen bars at or above erMin. */
export function checkTrendRegime(
  bars: readonly Candle[],
  params: Pick<TrendParams, "erLen" | "erMin">,
): RegimeCheck {
  const series = efficiencyRatioSeries(
    bars.map((bar) => bar.close),
    params.erLen,
  );
  const er = series[series.length - 1] ?? null;
  return { pass: er !== null && er >= params.erMin, er };
}

export interface TrendTriggerChecks {
  atrExpansion: AtrExpansionCheck;
  triggerBar: TriggerBarCheck;
  breakout: BreakoutCheck;
  volume: VolumeCheck;
  peers: { count: number; required: number; pass: boolean };
  regime: RegimeCheck;
}

export interface TrendTriggerResult {
  fired: boolean;
  barTs: number | null;
  close: number | null;
  atr: number | null;
  /** The broken channel edge; the entry stop anchors to it. Null unless the breakout check has a level. */
  baseLevel: number | null;
  checks: TrendTriggerChecks;
  /** Names of the failed gates, in evaluation order; the evaluator logs this verbatim. */
  failedChecks: string[];
}

/**
 * The composed entry decision for the latest confirmed bar. All gates must pass; the per-gate detail
 * rides along either way so a near miss is as observable as a fire.
 */
export function evaluateTrendTrigger(
  bars: readonly Candle[],
  peerBars: readonly (readonly Candle[])[],
  params: TrendParams,
  direction: TrendDirection,
): TrendTriggerResult {
  const atrSeries = wilderAtrSeries(bars, params.atrLen);
  const atrExpansion = checkAtrExpansion(atrSeries, params);
  const atr = atrExpansion.atr;
  const triggerBar = checkTriggerBar(bars, atr, direction, params);
  const breakout = checkBreakout(bars, direction, params);
  const volume = checkVolume(bars, params);
  const peerCount = countPeerConfirmations(peerBars, direction, params, bars[bars.length - 1]?.ts ?? null);
  const peers = { count: peerCount, required: params.peerMinCount, pass: peerCount >= params.peerMinCount };
  const regime = checkTrendRegime(bars, params);

  const gates: [string, boolean][] = [
    ["atr_expansion", atrExpansion.pass],
    ["trigger_bar", triggerBar.pass],
    ["breakout", breakout.pass],
    ["volume", volume.pass],
    ["peers", peers.pass],
    ["regime", regime.pass],
  ];
  const failedChecks = gates.filter(([, pass]) => !pass).map(([name]) => name);
  const last = bars[bars.length - 1];
  return {
    fired: failedChecks.length === 0,
    barTs: last?.ts ?? null,
    close: last?.close ?? null,
    atr,
    baseLevel: breakout.level,
    checks: { atrExpansion, triggerBar, breakout, volume, peers, regime },
    failedChecks,
  };
}

/** The entry stop: stopBufferAtr ATRs beyond the broken channel edge, against the position. */
export function trendInitialStop(
  direction: TrendDirection,
  baseLevel: number,
  atr: number,
  params: Pick<TrendParams, "stopBufferAtr">,
): number {
  return baseLevel - dirSign(direction) * params.stopBufferAtr * atr;
}

// ---------------------------------------------------------------------------
// Step helpers. Small duplicates of position.ts math (see the header note):
// floor a quantity to whole lots and format prices/quantities at a step.
// ---------------------------------------------------------------------------

function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError("step must be a positive finite number");
  const text = String(step);
  const exponentAt = text.indexOf("e-");
  if (exponentAt !== -1) {
    const mantissa = text.slice(0, exponentAt);
    const mantissaDecimals = mantissa.includes(".") ? mantissa.length - mantissa.indexOf(".") - 1 : 0;
    return mantissaDecimals + Number(text.slice(exponentAt + 2));
  }
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function roundToStep(value: number, step: number): number {
  const ticks = Math.round(value / step);
  return Number((ticks * step).toFixed(stepDecimals(step)));
}

/**
 * Rounds a protective stop onto the tick grid in the position's favour — up for a long, down for
 * a short — never away from it. Nearest-tick rounding can move a stop a half-tick against the
 * position, which silently widens the loss a plan was verified against; directional rounding
 * guarantees the submitted stop's worst-case loss is at most the verified one.
 */
export function roundTrendStop(direction: TrendDirection, px: number, tickSz: number): number {
  if (!(tickSz > 0) || !Number.isFinite(px)) return px;
  const ticks = px / tickSz;
  const whole = direction === "long" ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  return Number((whole * tickSz).toFixed(stepDecimals(tickSz)));
}

function formatStep(value: number, step: number): string {
  return value.toFixed(stepDecimals(step));
}

/** Floors a contract quantity to whole lots; null when that is below the minimum size or not positive. */
function floorLots(quantity: number, lotSz: number, minSz: number): number | null {
  const lots = Math.floor(quantity / lotSz + 1e-9);
  const sz = lots * lotSz;
  return sz > 0 && sz >= minSz ? sz : null;
}

/**
 * The largest size whose full loss at the stop fits the risk budget:
 * budget / (|entry - stop| x ctVal), floored to whole lots. Null when even the minimum size is too big.
 */
export function computeTrendSize(
  riskBudgetU: number,
  entryPx: number,
  stopPx: number,
  ctVal: number,
  lotSz: number,
  minSz: number,
): string | null {
  const distance = Math.abs(entryPx - stopPx);
  if (!(riskBudgetU > 0) || !(distance > 0) || !(ctVal > 0) || !(lotSz > 0)) return null;
  const sz = floorLots(riskBudgetU / (distance * ctVal), lotSz, minSz);
  return sz === null ? null : formatStep(sz, lotSz);
}

/** Cash loss if the whole position (blended average entry) is stopped out. Gains read as zero loss. */
export function worstCaseLossU(
  direction: TrendDirection,
  totalSz: number,
  avgEntryPx: number,
  stopPx: number,
  ctVal: number,
): number {
  const pnlPerUnit = dirSign(direction) * (stopPx - avgEntryPx);
  return Math.max(0, -pnlPerUnit * totalSz * ctVal);
}

// ---------------------------------------------------------------------------
// Runtime state: the strategy's memory between evaluations, stored as jsonb.
// parseTrendState is a tolerant reader — a corrupt or older state degrades to
// the empty state instead of wedging the evaluator.
// ---------------------------------------------------------------------------

export interface TrendRuntimeState {
  /** Blended average entry of the open position (observed on OKX, or the simulated fill in shadow). */
  entryPx: number | null;
  entryBarTs: number | null;
  entryAtr: number | null;
  /** Highest ATR seen since entry; the decay exit measures against it. */
  peakAtr: number | null;
  /** The unified stop the whole position is protected at. */
  stopPx: number | null;
  positionSz: number;
  adds: number;
  /** Fill price the next add step is measured from (entry fill, then each add's fill). */
  lastAddAnchorPx: number | null;
  lastAddBarTs: number | null;
  /**
   * Newest protective algo id this instance placed through order-submit (amend_tpsl). The
   * reconciler only ever cancels a leftover algo carrying this id: anything else protective on
   * the account may belong to external exposure and must survive.
   */
  protectiveAlgoId: string | null;
  /**
   * An add accepted by order-submit whose fill has not been observed on the account yet. While
   * set, no further add is planned and the unified stop is not advanced: committing the add
   * before the fill is visible would leave the filled size outside the tracked protection.
   */
  pendingAdd: { szNum: number; barTs: number; newStopPx: number; anchorPx: number } | null;
  /** Open time of the newest bar an evaluation has consumed; minutes without a new bar are no-ops. */
  lastEvalBarTs: number | null;
  /** Comma-joined failed gate names from the last trigger check; used to log only real changes. */
  lastChecksKey: string | null;
  exitReason: string | null;
}

export const EMPTY_TREND_STATE: TrendRuntimeState = {
  entryPx: null,
  entryBarTs: null,
  entryAtr: null,
  peakAtr: null,
  stopPx: null,
  positionSz: 0,
  adds: 0,
  lastAddAnchorPx: null,
  lastAddBarTs: null,
  protectiveAlgoId: null,
  pendingAdd: null,
  lastEvalBarTs: null,
  lastChecksKey: null,
  exitReason: null,
};

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseTrendState(raw: unknown): TrendRuntimeState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...EMPTY_TREND_STATE };
  const o = raw as Record<string, unknown>;
  const positionSz = numOrNull(o.positionSz);
  const adds = numOrNull(o.adds);
  const protectiveAlgoId = typeof o.protectiveAlgoId === "string" && o.protectiveAlgoId !== "" ? o.protectiveAlgoId : null;
  const pendingRaw = o.pendingAdd;
  const pendingAdd =
    typeof pendingRaw === "object" && pendingRaw !== null && !Array.isArray(pendingRaw)
      ? (() => {
          const p = pendingRaw as Record<string, unknown>;
          const szNum = numOrNull(p.szNum);
          const barTs = numOrNull(p.barTs);
          const newStopPx = numOrNull(p.newStopPx);
          const anchorPx = numOrNull(p.anchorPx);
          return szNum !== null && szNum > 0 && barTs !== null && newStopPx !== null && anchorPx !== null
            ? { szNum, barTs, newStopPx, anchorPx }
            : null;
        })()
      : null;
  return {
    entryPx: numOrNull(o.entryPx),
    entryBarTs: numOrNull(o.entryBarTs),
    entryAtr: numOrNull(o.entryAtr),
    peakAtr: numOrNull(o.peakAtr),
    stopPx: numOrNull(o.stopPx),
    positionSz: positionSz !== null && positionSz > 0 ? positionSz : 0,
    adds: adds !== null && Number.isInteger(adds) && adds > 0 ? adds : 0,
    lastAddAnchorPx: numOrNull(o.lastAddAnchorPx),
    lastAddBarTs: numOrNull(o.lastAddBarTs),
    protectiveAlgoId,
    pendingAdd,
    lastEvalBarTs: numOrNull(o.lastEvalBarTs),
    lastChecksKey: typeof o.lastChecksKey === "string" ? o.lastChecksKey : null,
    exitReason: typeof o.exitReason === "string" ? o.exitReason : null,
  };
}

/** The running ATR peak since entry: max of what state remembers and the newest reading. */
export function nextPeakAtr(state: Pick<TrendRuntimeState, "peakAtr">, atrNow: number | null): number | null {
  if (atrNow === null) return state.peakAtr;
  return state.peakAtr === null ? atrNow : Math.max(state.peakAtr, atrNow);
}

// ---------------------------------------------------------------------------
// Pyramid planning.
// ---------------------------------------------------------------------------

export interface TrendAddContext {
  direction: TrendDirection;
  params: TrendParams;
  /** Latest confirmed bar: its close is the decision price, its far edge the candidate stop base. */
  bar: Candle;
  atr: number;
  ctVal: number;
  lotSz: number;
  minSz: number;
  /** Size of the first unit; an add is never larger. */
  firstSz: number;
  themeStopCapU: number;
}

export type TrendAddPlan =
  | {
      add: true;
      /** Add size as an OKX decimal string. */
      sz: string;
      szNum: number;
      /** The unified stop after the add: the candidate, never worse than the current stop. */
      newStopPx: number;
      /** Whole-position worst-case loss at newStopPx after the add. */
      worstCaseLossU: number;
      /** The favourable excursion that triggered the plan, in price units. */
      excursion: number;
    }
  | { add: false; reason: string };

/**
 * One pyramid step. An add is planned when the close has travelled addStepAtr x ATR favourably from
 * the last fill anchor. The candidate stop anchors to the triggering bar's far edge (minus the buffer)
 * and only ever moves in the position's favour. The add size starts at the first unit's size and
 * shrinks by whole lots until the risk invariant holds — the whole position's worst-case loss at the
 * unified stop stays within the theme cap — or no add is planned at all.
 */
export function planTrendAdd(state: TrendRuntimeState, ctx: TrendAddContext): TrendAddPlan {
  const { params, direction } = ctx;
  if (state.positionSz <= 0 || state.entryPx === null || state.stopPx === null || state.lastAddAnchorPx === null) {
    return { add: false, reason: "no_position" };
  }
  if (state.adds >= params.maxAdds) return { add: false, reason: "max_adds_reached" };
  if (!(ctx.atr > 0)) return { add: false, reason: "atr_unavailable" };

  const sign = dirSign(direction);
  const excursion = sign * (ctx.bar.close - state.lastAddAnchorPx);
  const step = params.addStepAtr * ctx.atr;
  if (excursion < step) return { add: false, reason: "step_not_reached" };

  const farEdge = direction === "long" ? ctx.bar.low : ctx.bar.high;
  const candidate = farEdge - sign * params.stopBufferAtr * ctx.atr;
  const newStopPx = direction === "long" ? Math.max(state.stopPx, candidate) : Math.min(state.stopPx, candidate);

  const lotsAvailable = Math.floor(ctx.firstSz / ctx.lotSz + 1e-9);
  for (let lots = lotsAvailable; lots >= 1; lots -= 1) {
    const szNum = lots * ctx.lotSz;
    if (szNum < ctx.minSz) break;
    const totalSz = state.positionSz + szNum;
    const blendedAvg = (state.entryPx * state.positionSz + ctx.bar.close * szNum) / totalSz;
    const loss = worstCaseLossU(direction, totalSz, blendedAvg, newStopPx, ctx.ctVal);
    if (loss <= ctx.themeStopCapU) {
      return { add: true, sz: formatStep(szNum, ctx.lotSz), szNum, newStopPx, worstCaseLossU: loss, excursion };
    }
  }
  return { add: false, reason: "risk_cap" };
}

// ---------------------------------------------------------------------------
// Exit evaluation.
// ---------------------------------------------------------------------------

export interface TrendExitDecision {
  exit: boolean;
  reason: "atr_decay" | "ma_cross" | null;
  atr: number | null;
  /** Peak including the newest reading. */
  peakAtr: number | null;
  ma: number | null;
  close: number | null;
}

/**
 * The exit is evaluated on confirmed bars only: ATR decayed at least atrDecayExitPct from its peak
 * since entry, or the latest close sits on the adverse side of the slow MA. ATR decay is checked
 * first — a volatility regime that has ended is the primary "the trend state is over" signal.
 */
export function evaluateTrendExit(
  bars: readonly Candle[],
  state: TrendRuntimeState,
  params: TrendParams,
  direction: TrendDirection,
): TrendExitDecision {
  const last = bars[bars.length - 1];
  const atrSeries = wilderAtrSeries(bars, params.atrLen);
  const atr = atrSeries[atrSeries.length - 1] ?? null;
  const peakAtr = nextPeakAtr(state, atr);
  const maSeries = smaSeries(
    bars.map((bar) => bar.close),
    params.maExitLen,
  );
  const ma = maSeries[maSeries.length - 1] ?? null;
  const base: TrendExitDecision = { exit: false, reason: null, atr, peakAtr, ma, close: last?.close ?? null };
  if (!last || atr === null || peakAtr === null) return base;

  if (atr <= peakAtr * (1 - params.atrDecayExitPct / 100)) {
    return { ...base, exit: true, reason: "atr_decay" };
  }
  if (ma !== null) {
    const crossed = direction === "long" ? last.close < ma : last.close > ma;
    if (crossed) return { ...base, exit: true, reason: "ma_cross" };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Protection reconcile: the pure core of the "one unified stop covers the
// whole position" invariant. Desired state is exactly the set of protective
// algos sitting at the unified stop and summing to the position size.
// ---------------------------------------------------------------------------

/** The fields of an OKX pending algo the reconcile reads (PendingAlgo in position.ts satisfies this). */
export interface TrendAlgoView {
  algoId: string;
  side: string;
  posSide: string;
  reduceOnly: boolean;
  sz: number;
  slTriggerPx: string | null;
}

export type AlgoReconcileAction =
  | { kind: "amend_tpsl"; sz: string; slTriggerPx: string }
  | { kind: "cancel_algos"; algoIds: string[] };

export interface DesiredProtection {
  /** Total position size in contracts; 0 means flat and no protection should exist. */
  size: number;
  stopPx: number;
  lotSz: number;
  tickSz: number;
}

/** Protective algos for the position: reduce-only, on the closing side, carrying a stop trigger. */
export function protectiveAlgos(
  algos: readonly TrendAlgoView[],
  direction: TrendDirection,
  posSide: "net" | "long" | "short",
): TrendAlgoView[] {
  const side = direction === "long" ? "sell" : "buy";
  return algos.filter(
    (algo) =>
      algo.reduceOnly && algo.side === side && (posSide === "net" || algo.posSide === posSide) && algo.slTriggerPx !== null,
  );
}

/**
 * Plans how to converge the exchange's protective algos to the desired state. Convergence is one
 * amend_tpsl: order-submit places a fresh algo at (size, stop) and cancels the instrument's recorded
 * algos, so a single action replaces the whole set. A flat position plans a cancel of whatever
 * protective algos are left over. An already-exact set plans nothing.
 *
 * ignoreAlgoIds lists protective algos the caller has decided are not this strategy's to manage
 * (e.g. another strategy's or a manual stop): they are excluded from planning so they neither
 * trigger amend churn nor get swept, while the caller's own protection still converges.
 */
export function planAlgoReconcile(
  desired: DesiredProtection,
  algos: readonly TrendAlgoView[],
  direction: TrendDirection,
  posSide: "net" | "long" | "short",
  ignoreAlgoIds: readonly string[] = [],
): AlgoReconcileAction[] {
  const ignored = new Set(ignoreAlgoIds);
  const protective = protectiveAlgos(algos, direction, posSide).filter((algo) => !ignored.has(algo.algoId));
  if (desired.size <= 0) {
    return protective.length > 0 ? [{ kind: "cancel_algos", algoIds: protective.map((algo) => algo.algoId) }] : [];
  }
  const stopRounded = roundToStep(desired.stopPx, desired.tickSz);
  const coveredAtStop = protective
    .filter((algo) => roundToStep(Number(algo.slTriggerPx), desired.tickSz) === stopRounded)
    .reduce((sum, algo) => sum + algo.sz, 0);
  const exact =
    protective.length > 0 &&
    protective.every((algo) => roundToStep(Number(algo.slTriggerPx), desired.tickSz) === stopRounded) &&
    Math.abs(coveredAtStop - desired.size) <= 1e-9;
  if (exact) return [];
  return [{ kind: "amend_tpsl", sz: formatStep(desired.size, desired.lotSz), slTriggerPx: formatStep(stopRounded, desired.tickSz) }];
}

// ---------------------------------------------------------------------------
// Instance parsing (web API shape), mirroring parseConditionalOrderInput.
// ---------------------------------------------------------------------------

export interface TrendStrategyInput {
  mode: TrendAccountMode;
  /** Must be given explicitly at creation: shadow instances simulate and never submit an order. */
  runMode: TrendRunMode;
  instId: string;
  direction: TrendDirection;
  tdMode: "isolated" | "cross";
  lever: number;
  /** First unit size as a decimal string, exactly as it will be sent to OKX. */
  firstSz: string;
  theme: string;
  themeStopCapU: number;
  expiresAt: string;
  params: TrendParams;
  note: string | null;
}

export type TrendStrategyParse = { ok: true; value: TrendStrategyInput } | { ok: false; error: string };

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_EXPIRY_DAYS = 31;

export function parseTrendStrategyInput(input: unknown, nowMs: number): TrendStrategyParse {
  try {
    const o = requireObject(input, "body");
    const instId = typeof o.instId === "string" ? o.instId : "";
    if (!INST_ID.test(instId)) fail("instId must be a USDT-margined swap, e.g. NVDA-USDT-SWAP");
    // Required, like runMode: the evaluator only ever lists rows for its own account mode (from
    // OKX_TRADE_DEMO), so a silently defaulted mode can strand a dashboard-created instance in an
    // account the evaluator never reads — armed forever, with nothing evaluating it.
    const mode = o.mode;
    if (mode !== "demo" && mode !== "live") fail('mode is required and must be "demo" or "live"');
    if (o.runMode !== "shadow" && o.runMode !== "live") {
      fail('runMode is required and must be "shadow" or "live"');
    }
    const direction = o.direction;
    if (direction !== "long" && direction !== "short") fail('direction must be "long" or "short"');
    const lever = o.lever;
    if (typeof lever !== "number" || !Number.isFinite(lever) || lever < 1 || lever > 125) {
      fail("lever must be a number between 1 and 125");
    }
    const szRaw = o.firstSz;
    const firstSz = typeof szRaw === "number" ? String(szRaw) : typeof szRaw === "string" ? szRaw.trim() : "";
    if (!DECIMAL.test(firstSz) || Number(firstSz) <= 0) fail("firstSz must be a positive decimal");
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
      themeStopCapU > TREND_THEME_STOP_CAP_MAX_U
    ) {
      fail(`themeStopCapU must be a number in (0, ${TREND_THEME_STOP_CAP_MAX_U}]`);
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
    const params = parseTrendParams(o.params ?? {});
    if (params.peerInstIds.includes(instId)) fail("peerInstIds cannot include the strategy's own instId");
    return {
      ok: true,
      value: {
        mode: mode as TrendAccountMode,
        runMode: o.runMode,
        instId,
        direction,
        tdMode: tdMode as "isolated" | "cross",
        lever,
        firstSz,
        theme: theme as string,
        themeStopCapU,
        expiresAt,
        params,
        note: typeof noteRaw === "string" && noteRaw !== "" ? noteRaw : null,
      },
    };
  } catch (error) {
    if (error instanceof TrendError) return { ok: false, error: error.message };
    throw error;
  }
}
