import { createHash } from "node:crypto";

export const INTENT_SCHEMA = "okx.intent.v1";
export const DEFAULT_TTL_SEC = 120;
export const MAX_TTL_SEC = 3600;
/** Tolerated clock skew for createdAt values that are slightly ahead of Hive's clock. */
export const CLOCK_SKEW_MS = 60_000;

const ACTIONS = ["open", "close", "amend_tpsl", "reduce", "set_leverage", "adjust_margin"] as const;
const SIDES = ["buy", "sell"] as const;
const POS_SIDES = ["net", "long", "short"] as const;
const TD_MODES = ["isolated", "cross"] as const;
const ORD_TYPES = ["market", "limit"] as const;
const INST_ID = /^[A-Z0-9]+-USDT-SWAP$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export type IntentAction = (typeof ACTIONS)[number];
export type Side = (typeof SIDES)[number];
export type PosSide = (typeof POS_SIDES)[number];
export type TdMode = (typeof TD_MODES)[number];
export type OrdType = (typeof ORD_TYPES)[number];
export type TradeMode = "demo" | "live";

/** Parsed okx.intent.v1. Numeric OKX fields stay strings, exactly as they are sent to OKX. */
export interface OkxIntent {
  schema: typeof INTENT_SCHEMA;
  intentId: string;
  idempotencyKey: string;
  action: IntentAction;
  instId: string;
  side: Side;
  posSide: PosSide;
  tdMode: TdMode;
  lever: number | null;
  sz: string;
  ordType: OrdType;
  px: string | null;
  reduceOnly: boolean;
  slTriggerPx: string | null;
  slOrdPx: string | null;
  tpTriggerPx: string | null;
  tpOrdPx: string | null;
  theme: string | null;
  themeStopCapU: number | null;
  maxLossU: number | null;
  reason: string | null;
  source: string;
  createdAt: string;
  createdAtMs: number;
  ttlSec: number;
  /** Margin to add to the named position, in USDT. Only set for adjust_margin. */
  marginAmt: string | null;
}

export type ParseResult = { ok: true; intent: OkxIntent } | { ok: false; error: string };

export interface RiskLimitsView {
  maxNotionalUsdt: number;
  maxLeverage: number;
  maxOrdersPerMin: number;
}

export interface ClientOrderIds {
  clOrdId: string;
  attachAlgoClOrdId: string;
  algoClOrdId: string;
}

class IntentError extends Error {}

function fail(message: string): never {
  throw new IntentError(message);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requiredString(o: Record<string, unknown>, field: string, maxLength: number): string {
  const value = o[field];
  if (typeof value !== "string" || value.trim() === "") fail(`${field} is required`);
  if (value.length > maxLength) fail(`${field} exceeds ${maxLength} characters`);
  return value;
}

function optionalString(o: Record<string, unknown>, field: string, maxLength: number): string | null {
  const value = o[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.length > maxLength) fail(`${field} exceeds ${maxLength} characters`);
  return value;
}

function oneOf<T extends string>(o: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = o[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${field} must be one of ${allowed.join("|")}`);
  }
  return value as T;
}

function decimalString(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    return DECIMAL.test(text) ? text : null;
  }
  if (typeof value === "string" && DECIMAL.test(value.trim())) return value.trim();
  return null;
}

function requiredPositiveDecimal(o: Record<string, unknown>, field: string): string {
  const text = decimalString(o[field]);
  if (text === null || Number(text) <= 0) fail(`${field} must be a positive decimal`);
  return text;
}

function optionalPositiveDecimal(o: Record<string, unknown>, field: string): string | null {
  if (o[field] === undefined || o[field] === null) return null;
  return requiredPositiveDecimal(o, field);
}

/** Trigger prices are positive decimals; order prices are positive decimals or "-1" for a market order. */
function optionalOrdPx(o: Record<string, unknown>, field: string): string | null {
  if (o[field] === undefined || o[field] === null) return null;
  if (o[field] === "-1" || o[field] === -1) return "-1";
  return requiredPositiveDecimal(o, field);
}

function optionalPositiveNumber(o: Record<string, unknown>, field: string): number | null {
  const value = o[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${field} must be a positive number`);
  return value;
}

function optionalTtl(o: Record<string, unknown>): number {
  const value = o.ttlSec;
  if (value === undefined || value === null) return DEFAULT_TTL_SEC;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TTL_SEC) {
    fail(`ttlSec must be an integer between 1 and ${MAX_TTL_SEC}`);
  }
  return value;
}

const KNOWN_FIELDS = new Set([
  "schema",
  "intentId",
  "idempotencyKey",
  "action",
  "instId",
  "side",
  "posSide",
  "tdMode",
  "lever",
  "sz",
  "marginAmt",
  "ordType",
  "px",
  "reduceOnly",
  "slTriggerPx",
  "slOrdPx",
  "tpTriggerPx",
  "tpOrdPx",
  "theme",
  "themeStopCapU",
  "maxLossU",
  "reason",
  "source",
  "createdAt",
  "ttlSec",
]);

function buildIntent(input: unknown, nowMs: number): OkxIntent {
  const o = asObject(input) ?? fail("body must be a JSON object");
  if (o.schema !== INTENT_SCHEMA) fail(`schema must be ${INTENT_SCHEMA}`);
  const unknown = Object.keys(o).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknown.length > 0) fail(`unknown field(s): ${unknown.join(", ")}; a misspelt field would be silently dropped`);

  const intentId = requiredString(o, "intentId", 64);
  const idempotencyKey = requiredString(o, "idempotencyKey", 128);
  const action = oneOf(o, "action", ACTIONS);
  const instId = requiredString(o, "instId", 40);
  if (!INST_ID.test(instId)) fail("instId must be a USDT-margined swap, e.g. BTC-USDT-SWAP");
  const side = oneOf(o, "side", SIDES);
  const posSide = oneOf(o, "posSide", POS_SIDES);
  const tdMode = oneOf(o, "tdMode", TD_MODES);
  const source = requiredString(o, "source", 64);
  const createdAt = requiredString(o, "createdAt", 64);
  const createdAtMs = Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) fail("createdAt must be an ISO-8601 timestamp");
  if (createdAtMs > nowMs + CLOCK_SKEW_MS) fail("createdAt is in the future");
  const ttlSec = optionalTtl(o);

  const sz = requiredPositiveDecimal(o, "sz");
  const ordType = o.ordType === undefined || o.ordType === null ? "market" : oneOf(o, "ordType", ORD_TYPES);
  const px = optionalPositiveDecimal(o, "px");
  if (ordType === "limit" && px === null && action !== "amend_tpsl") fail("px is required for limit orders");

  const reduceOnly = o.reduceOnly === undefined || o.reduceOnly === null ? false : o.reduceOnly;
  if (typeof reduceOnly !== "boolean") fail("reduceOnly must be a boolean");
  if (action === "open" && reduceOnly) fail("open cannot be reduceOnly");
  if ((action === "close" || action === "reduce") && !reduceOnly) fail(`${action} must set reduceOnly=true`);

  const slTriggerPx = optionalPositiveDecimal(o, "slTriggerPx");
  const slOrdPx = optionalOrdPx(o, "slOrdPx");
  const tpTriggerPx = optionalPositiveDecimal(o, "tpTriggerPx");
  const tpOrdPx = optionalOrdPx(o, "tpOrdPx");
  if ((slTriggerPx === null) !== (slOrdPx === null)) fail("slTriggerPx and slOrdPx must be set together");
  if ((tpTriggerPx === null) !== (tpOrdPx === null)) fail("tpTriggerPx and tpOrdPx must be set together");
  if (action === "amend_tpsl" && slTriggerPx === null && tpTriggerPx === null) {
    fail("amend_tpsl needs slTriggerPx or tpTriggerPx");
  }

  const lever = o.lever === undefined || o.lever === null ? null : optionalPositiveNumber(o, "lever");

  if (action === "set_leverage") {
    // A leverage change names the position (side/posSide/sz, as on every intent) but places no order:
    // anything that only an order could consume would be silently dropped, so it is rejected instead.
    if (lever === null) fail("lever is required for set_leverage");
    if (reduceOnly) fail("set_leverage cannot be reduceOnly");
    if (px !== null) fail("set_leverage does not accept px");
    if (slTriggerPx !== null || tpTriggerPx !== null) fail("set_leverage does not accept sl/tp fields");
  }

  const marginAmt = optionalPositiveDecimal(o, "marginAmt");
  if (action === "adjust_margin") {
    // Margin can only be added to the position named by side/posSide/tdMode, so order-only fields are
    // rejected exactly as they are for set_leverage.
    if (marginAmt === null) fail("marginAmt is required for adjust_margin");
    if (lever !== null) fail("adjust_margin does not accept lever");
    if (reduceOnly) fail("adjust_margin cannot be reduceOnly");
    if (px !== null) fail("adjust_margin does not accept px");
    if (slTriggerPx !== null || tpTriggerPx !== null) fail("adjust_margin does not accept sl/tp fields");
    // OKX increase/decrease margin applies to isolated-margin positions only; reject cross here
    // instead of forwarding an operation the exchange cannot perform.
    if (tdMode !== "isolated") fail("adjust_margin only supports isolated positions");
  }

  return {
    schema: INTENT_SCHEMA,
    intentId,
    idempotencyKey,
    action,
    instId,
    side,
    posSide,
    tdMode,
    lever,
    sz,
    ordType,
    px,
    reduceOnly,
    slTriggerPx,
    slOrdPx,
    tpTriggerPx,
    tpOrdPx,
    theme: optionalString(o, "theme", 64),
    themeStopCapU: optionalPositiveNumber(o, "themeStopCapU"),
    maxLossU: optionalPositiveNumber(o, "maxLossU"),
    reason: optionalString(o, "reason", 500),
    source,
    createdAt,
    createdAtMs,
    ttlSec,
    marginAmt,
  };
}

/** Validates an okx.intent.v1 body. Shape errors are returned here; risk gates run later in preflightRisk. */
export function parseIntent(input: unknown, nowMs: number): ParseResult {
  try {
    return { ok: true, intent: buildIntent(input, nowMs) };
  } catch (error) {
    if (error instanceof IntentError) return { ok: false, error: error.message };
    throw error;
  }
}

export function isExpired(intent: OkxIntent, nowMs: number): boolean {
  return nowMs > intent.createdAtMs + intent.ttlSec * 1000;
}

/**
 * Deterministic OKX client order IDs derived from the idempotency key. OKX accepts up to 32 alphanumeric characters,
 * so each id is a one-letter prefix plus 31 hex digits of SHA-256. The same key always yields the same ids, which
 * lets a lookup by clOrdId recover an order whose response was lost.
 */
export function clientOrderIds(idempotencyKey: string): ClientOrderIds {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 31);
  return {
    clOrdId: `h${digest}`,
    attachAlgoClOrdId: `s${digest}`,
    algoClOrdId: `a${digest}`,
  };
}

/** Rejection codes returned before any price lookup or OKX call. Null means every preflight gate passed. */
export function preflightRisk(
  intent: OkxIntent,
  limits: RiskLimitsView | null,
  context: { killEngaged: boolean; submissionsLastMinute: number },
): string | null {
  if (context.killEngaged) return "kill_switch_engaged";
  if (!limits) return "no_risk_limits";
  if (context.submissionsLastMinute >= limits.maxOrdersPerMin) return "rate_limited";
  if (intent.action === "set_leverage") {
    if (intent.lever === null) return "missing_lever";
    if (intent.lever > limits.maxLeverage) return "leverage_exceeds_limit";
    return null;
  }
  // Adding margin increases the cushion, not the exposure: no notional, leverage or theme cap applies.
  if (intent.action === "adjust_margin") return null;
  if (intent.action !== "open") return null;

  if (intent.lever === null) return "missing_lever";
  if (intent.lever > limits.maxLeverage) return "leverage_exceeds_limit";
  if (intent.theme === null) return "missing_theme";
  if (intent.slTriggerPx === null || intent.slOrdPx === null) return "missing_stop_loss";
  if (intent.themeStopCapU === null) return "missing_theme_stop_cap";
  return null;
}

export interface PriceContext {
  /** Entry price: the limit px, the last price for a market open, or the average price of the position for amend_tpsl. */
  entryPx: number;
  /** OKX contract multiplier: base-currency units per contract. */
  ctVal: number;
}

/**
 * Notional and stop-loss gates, applied once the entry price is known. Loss uses notional x |entry - SL| / entry,
 * which equals sz x ctVal x |entry - SL|. Returns a rejection code or null.
 */
export function priceRisk(intent: OkxIntent, limits: RiskLimitsView, context: PriceContext): string | null {
  const { entryPx, ctVal } = context;
  if (!(entryPx > 0) || !(ctVal > 0)) return "price_unavailable";

  const notional = Number(intent.sz) * ctVal * entryPx;
  if (intent.action === "open" && notional > limits.maxNotionalUsdt) return "notional_exceeds_limit";

  if (intent.slTriggerPx === null) return null;
  const stop = Number(intent.slTriggerPx);
  const longPosition = intent.action === "open" ? intent.side === "buy" : intent.side === "sell";
  if (longPosition ? stop >= entryPx : stop <= entryPx) return "stop_loss_wrong_side";

  const loss = (notional * Math.abs(entryPx - stop)) / entryPx;
  if (intent.themeStopCapU !== null && loss > intent.themeStopCapU) return "loss_exceeds_theme_cap";
  if (intent.maxLossU !== null && loss > intent.maxLossU) return "loss_exceeds_max_loss";
  return null;
}

/** Whether the price gates need a live or position entry price. Opens always do; amend_tpsl only when it carries a cap. */
export function needsPriceGate(intent: OkxIntent): boolean {
  if (intent.action === "open") return true;
  return intent.action === "amend_tpsl" && (intent.themeStopCapU !== null || intent.maxLossU !== null);
}

/** OKX place-order body. posSide is omitted in net mode, which is how OKX expects it. */
export function placeOrderBody(intent: OkxIntent, ids: ClientOrderIds): Record<string, unknown> {
  const body: Record<string, unknown> = {
    instId: intent.instId,
    tdMode: intent.tdMode,
    side: intent.side,
    ordType: intent.ordType,
    sz: intent.sz,
    clOrdId: ids.clOrdId,
    reduceOnly: intent.action !== "open",
  };
  if (intent.posSide !== "net") body.posSide = intent.posSide;
  if (intent.ordType === "limit" && intent.px !== null) body.px = intent.px;
  if (intent.action === "open" && intent.slTriggerPx !== null && intent.slOrdPx !== null) {
    const attach: Record<string, unknown> = {
      attachAlgoClOrdId: ids.attachAlgoClOrdId,
      slTriggerPx: intent.slTriggerPx,
      slOrdPx: intent.slOrdPx,
      slTriggerPxType: "last",
    };
    if (intent.tpTriggerPx !== null && intent.tpOrdPx !== null) {
      attach.tpTriggerPx = intent.tpTriggerPx;
      attach.tpOrdPx = intent.tpOrdPx;
      attach.tpTriggerPxType = "last";
    }
    body.attachAlgoOrds = [attach];
  }
  return body;
}

/** OKX algo order body for amend_tpsl. Always reduce-only, so it can only close exposure. */
export function algoOrderBody(intent: OkxIntent, algoClOrdId: string): Record<string, unknown> {
  const hasSl = intent.slTriggerPx !== null && intent.slOrdPx !== null;
  const hasTp = intent.tpTriggerPx !== null && intent.tpOrdPx !== null;
  const body: Record<string, unknown> = {
    instId: intent.instId,
    tdMode: intent.tdMode,
    side: intent.side,
    ordType: hasSl && hasTp ? "oco" : "conditional",
    sz: intent.sz,
    reduceOnly: true,
    algoClOrdId,
  };
  if (intent.posSide !== "net") body.posSide = intent.posSide;
  if (hasSl) {
    body.slTriggerPx = intent.slTriggerPx;
    body.slOrdPx = intent.slOrdPx;
    body.slTriggerPxType = "last";
  }
  if (hasTp) {
    body.tpTriggerPx = intent.tpTriggerPx;
    body.tpOrdPx = intent.tpOrdPx;
    body.tpTriggerPxType = "last";
  }
  return body;
}

/** OKX position/margin-balance body. Only adding margin is supported, to the position named by posSide and tdMode. */
export function adjustMarginBody(intent: OkxIntent): Record<string, unknown> {
  if (intent.marginAmt === null) throw new Error("adjust_margin reached the OKX body without a marginAmt");
  return { instId: intent.instId, posSide: intent.posSide, type: "add", amt: intent.marginAmt };
}
