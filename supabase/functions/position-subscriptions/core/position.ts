// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import { createHash } from "node:crypto";

/** Management actions reuse the 3-minute bucket of the okx.intent.v1 key scheme. */
export const ACTION_BUCKET_MS = 180_000;
export const MIN_TP_MARK_FRACTION = 0.0005;
export const THEME_STOP_CAP_MAX_U = 0.1;
export const MAX_NOTE_LENGTH = 500;

export type PositionMode = "demo" | "live";
export type PosSideName = "net" | "long" | "short";
export type Direction = "long" | "short";
export type ClosingSide = "buy" | "sell";

/** One enabled row of position_subscriptions, in camelCase. */
export interface PositionSubscription {
  id: string;
  mode: PositionMode;
  instId: string;
  posSide: PosSideName;
  direction: Direction;
  tdMode: "isolated" | "cross";
  entryPx: number;
  slPx: number;
  tpPx: number;
  midPx: number;
  themeStopCapU: number;
  atrLen: number;
  atrMult: number;
  amendMinAtrFrac: number;
  halfReduceFrac: number;
  dynamicTpEnabled: boolean;
  halfReduceEnabled: boolean;
  halfReduceDone: boolean;
  halfReduceAttempts: number;
}

/** A pending conditional or OCO algo order as OKX reports it. Trigger and order prices stay as OKX sent them. */
export interface PendingAlgo {
  algoId: string;
  algoClOrdId: string;
  side: string;
  posSide: string;
  sz: number;
  reduceOnly: boolean;
  slTriggerPx: string | null;
  slOrdPx: string | null;
  tpTriggerPx: string | null;
  tpOrdPx: string | null;
}

/** One non-zero account position row. pos is signed in net mode and positive in long/short mode. */
export interface PositionRow {
  posSide: string;
  pos: number;
  avgPx: number;
  markPx: number;
}

export interface InstrumentSpec {
  ctVal: number;
  lotSz: number;
  minSz: number;
  tickSz: number;
}

export function closingSide(direction: Direction): ClosingSide {
  return direction === "long" ? "sell" : "buy";
}

/** Midpoint between the average entry and the stop. Half-way invalidation compares closes against it. */
export function halfWayLevel(entryPx: number, slPx: number): number {
  return (entryPx + slPx) / 2;
}

/** Entry moved in the profit direction by atr x mult. */
export function dynamicTakeProfit(direction: Direction, entryPx: number, atr: number, mult: number): number {
  const move = atr * mult;
  return direction === "long" ? entryPx + move : entryPx - move;
}

/** Decimal places of an OKX increment such as 0.1, 0.01 or 1e-7. */
export function decimalsOf(step: number): number {
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

export function roundToStep(value: number, step: number): number {
  const ticks = Math.round(value / step);
  return Number((ticks * step).toFixed(decimalsOf(step)));
}

export function formatToStep(value: number, step: number): string {
  return value.toFixed(decimalsOf(step));
}

/** A TP is only safe to place when price has not reached it yet. Otherwise OKX would fill it at once. */
export function tpBeyondMark(direction: Direction, tpPx: number, markPx: number, minFraction: number): boolean {
  return direction === "long" ? tpPx > markPx * (1 + minFraction) : tpPx < markPx * (1 - minFraction);
}

/** |newTP - currentTP| in ATR units. A missing current TP counts as infinitely far away. */
export function tpDeviationAtr(newTp: number, currentTp: number | null, atr: number): number {
  if (currentTp === null) return Number.POSITIVE_INFINITY;
  return Math.abs(newTp - currentTp) / atr;
}

/** A confirmed close on the wrong side of the midpoint means the midpoint did not hold. */
export function halfWayFailed(direction: Direction, midPx: number, closePx: number): boolean {
  return direction === "long" ? closePx <= midPx : closePx >= midPx;
}

/** Floors frac x size to whole lots. Returns null when the result is below the minimum order size. */
export function halfReduceSize(size: number, lotSz: number, minSz: number, frac: number): string | null {
  const lots = Math.floor((size * frac) / lotSz + 1e-9);
  const sz = lots * lotSz;
  if (!(sz > 0) || sz < minSz || sz >= size) return null;
  return formatToStep(sz, lotSz);
}

/**
 * The protective OCO/conditional stop that closes this position. Orders on the closing side are the position's
 * protection. The largest one is used, and its prices are kept as OKX reports them.
 */
export function selectProtection(
  algos: readonly PendingAlgo[],
  direction: Direction,
  posSide: PosSideName,
): PendingAlgo | null {
  const side = closingSide(direction);
  const candidates = algos
    .filter(
      (algo) =>
        algo.reduceOnly &&
        algo.side === side &&
        (posSide === "net" || algo.posSide === posSide) &&
        algo.slTriggerPx !== null,
    )
    .sort((a, b) => b.sz - a.sz);
  return candidates[0] ?? null;
}

export type PositionMatch =
  | { kind: "none" }
  | { kind: "skip"; reason: string }
  | { kind: "ok"; size: number; markPx: number };

/** Finds the subscribed position in OKX rows and checks that its direction still matches the subscription. */
export function matchPosition(rows: readonly PositionRow[], sub: Pick<PositionSubscription, "posSide" | "direction">): PositionMatch {
  const row = rows.find((candidate) => (sub.posSide === "net" ? candidate.posSide === "net" : candidate.posSide === sub.posSide));
  if (!row || row.pos === 0) return { kind: "none" };
  if (!Number.isFinite(row.pos)) return { kind: "skip", reason: "position_size_unavailable" };
  if (sub.posSide === "net") {
    const observed: Direction = row.pos > 0 ? "long" : "short";
    if (observed !== sub.direction) return { kind: "skip", reason: `direction_mismatch:${observed}` };
  }
  if (!Number.isFinite(row.markPx) || row.markPx <= 0) return { kind: "skip", reason: "mark_price_unavailable" };
  return { kind: "ok", size: Math.abs(row.pos), markPx: row.markPx };
}

export function actionBucket(nowMs: number): number {
  return Math.floor(nowMs / ACTION_BUCKET_MS);
}

/** Deterministic 32-hex key. Callers include the action, instrument, rounded levels and time bucket. */
export function managementKey(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 32);
}

export interface AmendIntentInput {
  intentId: string;
  idempotencyKey: string;
  createdAt: string;
  source: string;
  instId: string;
  direction: Direction;
  posSide: PosSideName;
  tdMode: "isolated" | "cross";
  sz: string;
  slTriggerPx: string;
  slOrdPx: string;
  tpTriggerPx: string | null;
  tpOrdPx: string | null;
  reason: string;
  ttlSec: number;
}

/** okx.intent.v1 amend_tpsl. The stop is re-sent unchanged, so OKX replaces the whole OCO and the stop never drops out. */
export function amendIntent(input: AmendIntentInput): Record<string, unknown> {
  const intent: Record<string, unknown> = {
    schema: "okx.intent.v1",
    intentId: input.intentId,
    idempotencyKey: input.idempotencyKey,
    action: "amend_tpsl",
    instId: input.instId,
    side: closingSide(input.direction),
    posSide: input.posSide,
    tdMode: input.tdMode,
    sz: input.sz,
    ordType: "market",
    reduceOnly: true,
    slTriggerPx: input.slTriggerPx,
    slOrdPx: input.slOrdPx,
    reason: input.reason,
    source: input.source,
    createdAt: input.createdAt,
    ttlSec: input.ttlSec,
  };
  if (input.tpTriggerPx !== null) {
    intent.tpTriggerPx = input.tpTriggerPx;
    intent.tpOrdPx = input.tpOrdPx ?? "-1";
  }
  return intent;
}

export interface ReduceIntentInput {
  intentId: string;
  idempotencyKey: string;
  createdAt: string;
  source: string;
  instId: string;
  direction: Direction;
  posSide: PosSideName;
  tdMode: "isolated" | "cross";
  sz: string;
  reason: string;
  ttlSec: number;
}

/** okx.intent.v1 reduce: market, reduce-only, on the closing side. */
export function reduceIntent(input: ReduceIntentInput): Record<string, unknown> {
  return {
    schema: "okx.intent.v1",
    intentId: input.intentId,
    idempotencyKey: input.idempotencyKey,
    action: "reduce",
    instId: input.instId,
    side: closingSide(input.direction),
    posSide: input.posSide,
    tdMode: input.tdMode,
    sz: input.sz,
    ordType: "market",
    reduceOnly: true,
    reason: input.reason,
    source: input.source,
    createdAt: input.createdAt,
    ttlSec: input.ttlSec,
  };
}

export interface SubscriptionInput {
  mode: PositionMode;
  instId: string;
  posSide: PosSideName;
  direction: Direction;
  tdMode: "isolated" | "cross";
  lever: number;
  entryPx: number;
  slPx: number;
  tpPx: number;
  midPx: number;
  themeStopCapU: number;
  theme: string | null;
  atrLen: number;
  atrMult: number;
  amendMinAtrFrac: number;
  halfReduceFrac: number;
  dynamicTpEnabled: boolean;
  halfReduceEnabled: boolean;
  enabled: boolean;
  resetState: boolean;
  note: string | null;
}

export type SubscriptionParse = { ok: true; value: SubscriptionInput } | { ok: false; error: string };

class SubscriptionError extends Error {}

function fail(message: string): never {
  throw new SubscriptionError(message);
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("body must be a JSON object");
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(o: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = o[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${field} must be one of ${allowed.join("|")}`);
  }
  return value as T;
}

function positive(o: Record<string, unknown>, field: string, max = Number.POSITIVE_INFINITY): number {
  const value = o[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    fail(`${field} must be a positive number${max < Number.POSITIVE_INFINITY ? ` no greater than ${max}` : ""}`);
  }
  return value;
}

function optionalNumber(o: Record<string, unknown>, field: string, fallback: number, max: number): number {
  if (o[field] === undefined || o[field] === null) return fallback;
  return positive(o, field, max);
}

function optionalBoolean(o: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = o[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function optionalText(o: Record<string, unknown>, field: string, maxLength: number): string | null {
  const value = o[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.length > maxLength) fail(`${field} exceeds ${maxLength} characters`);
  return value;
}

const INST_ID = /^[A-Z0-9]+-USDT-SWAP$/;

/**
 * Validates a position subscription upsert. Instrument scope is not limited here: any USDT swap that has a
 * subscription can be managed. Geometry is checked against the side: a long's stop is at or below entry and its
 * TP above it, and a short's is the reverse. A supplied midpoint must sit between entry and stop.
 */
export function parseSubscriptionUpsert(input: unknown): SubscriptionParse {
  try {
    const o = objectOf(input);
    const instId = typeof o.instId === "string" ? o.instId : "";
    if (!INST_ID.test(instId)) fail("instId must be a USDT-margined swap, e.g. BTC-USDT-SWAP");
    const mode = oneOf(o, "mode", ["demo", "live"] as const);
    const posSide = oneOf(o, "posSide", ["net", "long", "short"] as const);
    const direction = oneOf(o, "direction", ["long", "short"] as const);
    if (posSide !== "net" && posSide !== direction) fail("posSide long/short must equal direction");
    const tdMode = o.tdMode === undefined || o.tdMode === null ? "isolated" : oneOf(o, "tdMode", ["isolated", "cross"] as const);
    const lever = positive(o, "lever", 125);
    const entryPx = positive(o, "entryPx");
    const slPx = positive(o, "slPx");
    const tpPx = positive(o, "tpPx");
    if (direction === "long") {
      if (slPx > entryPx) fail("a long needs slPx at or below entryPx");
      if (tpPx <= entryPx) fail("a long needs tpPx above entryPx");
    } else {
      if (slPx < entryPx) fail("a short needs slPx at or above entryPx");
      if (tpPx >= entryPx) fail("a short needs tpPx below entryPx");
    }
    const low = Math.min(entryPx, slPx);
    const high = Math.max(entryPx, slPx);
    const midPx = o.midPx === undefined || o.midPx === null ? halfWayLevel(entryPx, slPx) : positive(o, "midPx");
    if (midPx < low || midPx > high) fail("midPx must lie between entryPx and slPx");
    const themeStopCapU = positive(o, "themeStopCapU", THEME_STOP_CAP_MAX_U);
    const theme = optionalText(o, "theme", 64);
    const note = optionalText(o, "note", MAX_NOTE_LENGTH);
    const atrLen = optionalNumber(o, "atrLen", 14, 100);
    if (!Number.isInteger(atrLen) || atrLen < 2) fail("atrLen must be an integer between 2 and 100");
    return {
      ok: true,
      value: {
        mode,
        instId,
        posSide,
        direction,
        tdMode,
        lever,
        entryPx,
        slPx,
        tpPx,
        midPx,
        themeStopCapU,
        theme,
        atrLen,
        atrMult: optionalNumber(o, "atrMult", 0.8, 5),
        amendMinAtrFrac: optionalNumber(o, "amendMinAtrFrac", 0.15, 5),
        halfReduceFrac: optionalNumber(o, "halfReduceFrac", 0.5, 0.99),
        dynamicTpEnabled: optionalBoolean(o, "dynamicTpEnabled", true),
        halfReduceEnabled: optionalBoolean(o, "halfReduceEnabled", true),
        enabled: optionalBoolean(o, "enabled", true),
        resetState: optionalBoolean(o, "resetState", false),
        note,
      },
    };
  } catch (error) {
    if (error instanceof SubscriptionError) return { ok: false, error: error.message };
    throw error;
  }
}
