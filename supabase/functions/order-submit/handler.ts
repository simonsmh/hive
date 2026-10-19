import { isAuthorized } from "./core/auth.ts";
import {
  algoOrderBody,
  clientOrderIds,
  type ClientOrderIds,
  type IntentAction,
  isExpired,
  needsPriceGate,
  type OkxIntent,
  parseIntent,
  placeOrderBody,
  preflightRisk,
  priceRisk,
  type OrdType,
  type PosSide,
  type RiskLimitsView,
  type Side,
  type TdMode,
  type TradeMode,
} from "./core/order-intent.ts";
import { type OrderTrade, OkxTradeError, type PlacedAlgo, type PlacedOrder } from "./core/okx-trade.ts";

export const MAX_BODY_BYTES = 16_384;
export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
export const RATE_WINDOW_MS = 60_000;

export type TerminalStatus = "acked" | "rejected_risk" | "rejected_auth" | "expired" | "exchange_error";
export type ResponseStatus =
  | TerminalStatus
  | "rejected_invalid"
  | "in_progress"
  | "duplicate_key_expired"
  | "duplicate_intent_id";

export interface IntentOutcome {
  status: TerminalStatus;
  reason: string | null;
  ordId: string | null;
  algoId: string | null;
  clOrdId: string | null;
  state: string | null;
  detail: string | null;
}

export interface StoredIntent extends Omit<IntentOutcome, "status"> {
  status: TerminalStatus | "received";
  receivedAtMs: number;
}

/** Column-level view of an accepted intent. The store maps these to snake_case columns. */
export interface IntentRecord {
  intentId: string;
  idempotencyKey: string;
  mode: TradeMode;
  schemaVersion: string;
  action: IntentAction;
  source: string;
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
  intentCreatedAt: string;
  ttlSec: number;
  clOrdId: string;
  request: unknown;
}

export interface OrderRecord {
  intentId: string;
  mode: TradeMode;
  action: IntentAction;
  kind: "order" | "algo";
  instId: string;
  side: Side;
  posSide: PosSide;
  ordType: OrdType | "oco" | "conditional";
  ordId: string | null;
  algoId: string | null;
  clOrdId: string;
  sz: string;
  px: string | null;
  state: string;
}

export type InsertResult = { inserted: true } | { inserted: false; existing: StoredIntent | null };

export interface OrderStore {
  killSwitchEngaged(): Promise<boolean>;
  riskLimits(mode: TradeMode): Promise<RiskLimitsView | null>;
  insertIntent(record: IntentRecord): Promise<InsertResult>;
  finishIntent(idempotencyKey: string, outcome: IntentOutcome): Promise<void>;
  submissionsSince(mode: TradeMode, sinceMs: number, excludeIdempotencyKey: string): Promise<number>;
  recordOrder(record: OrderRecord): Promise<void>;
  liveAlgos(instId: string, mode: TradeMode): Promise<{ algoId: string; clOrdId: string }[]>;
  setOrderState(clOrdId: string, state: string): Promise<void>;
}

export interface OrderSubmitDeps {
  orderToken: string | undefined;
  mode: TradeMode;
  liveEnabled: boolean;
  store: OrderStore;
  trade: OrderTrade;
  now?: () => number;
  log?: (message: string) => void;
}

interface ResponseFields {
  intentId: string | null;
  idempotencyKey: string | null;
  mode: TradeMode;
  status: ResponseStatus;
  reason: string | null;
  ordId: string | null;
  algoId: string | null;
  clOrdId: string | null;
  state: string | null;
  detail: string | null;
  duplicate?: true;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function httpStatusFor(status: ResponseStatus, reason: string | null): number {
  switch (status) {
    case "acked":
      return 200;
    case "rejected_risk":
      return reason === "kill_switch_engaged" ? 423 : 422;
    case "expired":
      return 422;
    case "rejected_auth":
      return 401;
    case "rejected_invalid":
      return 400;
    case "exchange_error":
      return 502;
    case "in_progress":
    case "duplicate_key_expired":
    case "duplicate_intent_id":
      return 409;
    default:
      return 500;
  }
}

function respond(fields: ResponseFields): Response {
  return json(httpStatusFor(fields.status, fields.reason), fields);
}

function rejection(
  mode: TradeMode,
  status: ResponseStatus,
  reason: string,
  intent: { intentId: string; idempotencyKey: string } | null = null,
): Response {
  return respond({
    intentId: intent?.intentId ?? null,
    idempotencyKey: intent?.idempotencyKey ?? null,
    mode,
    status,
    reason,
    ordId: null,
    algoId: null,
    clOrdId: null,
    state: null,
    detail: null,
  });
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function terminal(status: TerminalStatus, reason: string, clOrdId: string | null = null): IntentOutcome {
  return { status, reason, ordId: null, algoId: null, clOrdId, state: null, detail: null };
}

function failedPlacement(error: unknown, clOrdId: string): IntentOutcome {
  if (error instanceof OkxTradeError) {
    if (error.isAuth) {
      return { ...terminal("rejected_auth", `okx_auth:${error.code ?? error.httpStatus}`, clOrdId), detail: error.message };
    }
    if (error.kind === "api") {
      return { ...terminal("exchange_error", `okx_rejected:${error.sCode ?? error.code ?? "unknown"}`, clOrdId), detail: error.message };
    }
    if (error.kind === "http") {
      return { ...terminal("exchange_error", `okx_http:${error.httpStatus ?? "unknown"}`, clOrdId), detail: error.message };
    }
  }
  return { ...terminal("exchange_error", "hive_internal", clOrdId), detail: describeError(error) };
}

function toRecord(intent: OkxIntent, ids: ClientOrderIds, mode: TradeMode, request: unknown): IntentRecord {
  return {
    intentId: intent.intentId,
    idempotencyKey: intent.idempotencyKey,
    mode,
    schemaVersion: intent.schema,
    action: intent.action,
    source: intent.source,
    instId: intent.instId,
    side: intent.side,
    posSide: intent.posSide,
    tdMode: intent.tdMode,
    lever: intent.lever,
    sz: intent.sz,
    ordType: intent.ordType,
    px: intent.px,
    reduceOnly: intent.reduceOnly,
    slTriggerPx: intent.slTriggerPx,
    slOrdPx: intent.slOrdPx,
    tpTriggerPx: intent.tpTriggerPx,
    tpOrdPx: intent.tpOrdPx,
    theme: intent.theme,
    themeStopCapU: intent.themeStopCapU,
    maxLossU: intent.maxLossU,
    reason: intent.reason,
    intentCreatedAt: intent.createdAt,
    ttlSec: intent.ttlSec,
    clOrdId: ids.clOrdId,
    request,
  };
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES ? null : text;
}

async function entryContext(
  intent: OkxIntent,
  trade: OrderTrade,
): Promise<{ entryPx: number; ctVal: number } | null> {
  if (intent.action === "open") {
    const [entryPx, ctVal] = await Promise.all([
      intent.ordType === "limit" && intent.px !== null ? Number(intent.px) : trade.lastPrice(intent.instId),
      trade.contractValue(intent.instId),
    ]);
    return { entryPx, ctVal };
  }
  const position = await trade.position(intent.instId);
  if (position === null) return null;
  return { entryPx: position.avgPx, ctVal: await trade.contractValue(intent.instId) };
}

/**
 * Leverage change on an existing position. No order is placed and nothing is written to the orders
 * table: the intent row and its stored outcome are the audit trail. OKX applies the new leverage to
 * the position in the intent's tdMode; attached algo orders are unaffected.
 */
async function placeSetLeverage(
  intent: OkxIntent,
  ids: ClientOrderIds,
  deps: OrderSubmitDeps,
): Promise<IntentOutcome> {
  if (intent.lever === null) throw new Error("set_leverage reached placement without a lever");
  try {
    await deps.trade.setLeverage(intent.instId, intent.lever, intent.tdMode);
  } catch (error) {
    return failedPlacement(error, ids.clOrdId);
  }
  return {
    status: "acked",
    reason: null,
    ordId: null,
    algoId: null,
    clOrdId: ids.clOrdId,
    state: "accepted",
    detail: `lever_set=${intent.lever}`,
  };
}

async function placeOpenOrClose(
  intent: OkxIntent,
  ids: ClientOrderIds,
  deps: OrderSubmitDeps,
): Promise<IntentOutcome> {
  if (intent.action === "open") {
    if (intent.lever === null) throw new Error("open reached placement without a lever");
    try {
      await deps.trade.setLeverage(intent.instId, intent.lever, intent.tdMode);
    } catch (error) {
      return failedPlacement(error, ids.clOrdId);
    }
  }

  let placed: PlacedOrder;
  try {
    placed = await deps.trade.placeOrder(placeOrderBody(intent, ids));
  } catch (error) {
    if (error instanceof OkxTradeError && error.kind === "network") {
      return reconcileOrder(intent, ids, deps, error);
    }
    return failedPlacement(error, ids.clOrdId);
  }

  const warning = await recordPlacedOrder(intent, ids.clOrdId, placed.ordId, deps);
  return {
    status: "acked",
    reason: null,
    ordId: placed.ordId,
    algoId: null,
    clOrdId: placed.clOrdId || ids.clOrdId,
    state: "accepted",
    detail: warning,
  };
}

async function recordPlacedOrder(
  intent: OkxIntent,
  clOrdId: string,
  ordId: string,
  deps: OrderSubmitDeps,
): Promise<string | null> {
  try {
    await deps.store.recordOrder({
      intentId: intent.intentId,
      mode: deps.mode,
      action: intent.action,
      kind: "order",
      instId: intent.instId,
      side: intent.side,
      posSide: intent.posSide,
      ordType: intent.ordType,
      ordId,
      algoId: null,
      clOrdId,
      sz: intent.sz,
      px: intent.px,
      state: "accepted",
    });
    return null;
  } catch (error) {
    return `order_record_failed: ${describeError(error)}`;
  }
}

/** A network failure leaves it unknown whether OKX accepted the order. The deterministic clOrdId settles that. */
async function reconcileOrder(
  intent: OkxIntent,
  ids: ClientOrderIds,
  deps: OrderSubmitDeps,
  error: OkxTradeError,
): Promise<IntentOutcome> {
  try {
    const found = await deps.trade.findOrderByClOrdId(intent.instId, ids.clOrdId);
    if (found) {
      const warning = await recordPlacedOrder(intent, ids.clOrdId, found.ordId, deps);
      return {
        status: "acked",
        reason: null,
        ordId: found.ordId,
        algoId: null,
        clOrdId: ids.clOrdId,
        state: found.state || "accepted",
        detail: ["recovered_after_network_error", warning].filter(Boolean).join("; "),
      };
    }
  } catch {
    // Fall through: the outcome stays unknown and is reported as such.
  }
  return { ...terminal("exchange_error", "outcome_unknown", ids.clOrdId), detail: error.message };
}

async function placeAmend(intent: OkxIntent, ids: ClientOrderIds, deps: OrderSubmitDeps): Promise<IntentOutcome> {
  const warnings: string[] = [];
  let previous: { algoId: string; clOrdId: string }[] = [];
  try {
    previous = await deps.store.liveAlgos(intent.instId, deps.mode);
  } catch (error) {
    warnings.push(`previous_algos_unknown: ${describeError(error)}`);
  }

  let placed: PlacedAlgo;
  try {
    placed = await deps.trade.placeAlgo(algoOrderBody(intent, ids.algoClOrdId));
  } catch (error) {
    if (error instanceof OkxTradeError && error.kind === "network") {
      return { ...terminal("exchange_error", "outcome_unknown", ids.algoClOrdId), detail: error.message };
    }
    return failedPlacement(error, ids.algoClOrdId);
  }

  try {
    await deps.store.recordOrder({
      intentId: intent.intentId,
      mode: deps.mode,
      action: intent.action,
      kind: "algo",
      instId: intent.instId,
      side: intent.side,
      posSide: intent.posSide,
      ordType: intent.tpTriggerPx !== null && intent.slTriggerPx !== null ? "oco" : "conditional",
      ordId: null,
      algoId: placed.algoId,
      clOrdId: ids.algoClOrdId,
      sz: intent.sz,
      px: null,
      state: "accepted",
    });
  } catch (error) {
    warnings.push(`algo_record_failed: ${describeError(error)}`);
  }

  const replaced: string[] = [];
  for (const old of previous) {
    try {
      await deps.trade.cancelAlgos([{ algoId: old.algoId, instId: intent.instId }]);
      replaced.push(old.algoId);
      await deps.store.setOrderState(old.clOrdId, "canceled");
    } catch (error) {
      warnings.push(`cancel_previous_algo ${old.algoId} failed: ${describeError(error)}`);
    }
  }
  if (replaced.length > 0) warnings.push(`replaced_algo_ids=${replaced.join(",")}`);

  return {
    status: "acked",
    reason: null,
    ordId: null,
    algoId: placed.algoId,
    clOrdId: ids.algoClOrdId,
    state: "accepted",
    detail: warnings.length > 0 ? warnings.join("; ") : null,
  };
}

async function execute(intent: OkxIntent, ids: ClientOrderIds, deps: OrderSubmitDeps, nowMs: number): Promise<IntentOutcome> {
  if (isExpired(intent, nowMs)) return terminal("expired", "ttl_expired", ids.clOrdId);

  const [killEngaged, limits, submissionsLastMinute] = await Promise.all([
    deps.store.killSwitchEngaged(),
    deps.store.riskLimits(deps.mode),
    deps.store.submissionsSince(deps.mode, nowMs - RATE_WINDOW_MS, intent.idempotencyKey),
  ]);

  const preflight = preflightRisk(intent, limits, { killEngaged, submissionsLastMinute });
  if (preflight !== null) return terminal("rejected_risk", preflight, ids.clOrdId);
  if (limits === null) return terminal("rejected_risk", "no_risk_limits", ids.clOrdId);

  if (needsPriceGate(intent)) {
    const context = await entryContext(intent, deps.trade);
    if (context === null) return terminal("rejected_risk", "no_position", ids.clOrdId);
    const priceReject = priceRisk(intent, limits, context);
    if (priceReject !== null) return terminal("rejected_risk", priceReject, ids.clOrdId);
  }

  if (intent.action === "amend_tpsl") return placeAmend(intent, ids, deps);
  if (intent.action === "set_leverage") return placeSetLeverage(intent, ids, deps);
  return placeOpenOrClose(intent, ids, deps);
}

function fieldsFor(
  intentId: string | null,
  idempotencyKey: string | null,
  mode: TradeMode,
  outcome: IntentOutcome,
  duplicate = false,
): ResponseFields {
  return {
    intentId,
    idempotencyKey,
    mode,
    status: outcome.status,
    reason: outcome.reason,
    ordId: outcome.ordId,
    algoId: outcome.algoId,
    clOrdId: outcome.clOrdId,
    state: outcome.state,
    detail: outcome.detail,
    ...(duplicate ? { duplicate: true as const } : {}),
  };
}

function replay(intent: OkxIntent, existing: StoredIntent | null, nowMs: number, mode: TradeMode): Response {
  if (existing === null) {
    return rejection(mode, "duplicate_intent_id", "intentId is already used by another idempotencyKey", intent);
  }
  if (nowMs - existing.receivedAtMs > IDEMPOTENCY_WINDOW_MS) {
    return rejection(mode, "duplicate_key_expired", "idempotencyKey was used more than 10 minutes ago; send a new key", intent);
  }
  if (existing.status === "received") {
    return rejection(mode, "in_progress", "a previous request with this idempotencyKey has not finished", intent);
  }
  const outcome: IntentOutcome = { ...existing, status: existing.status };
  return respond(fieldsFor(intent.intentId, intent.idempotencyKey, mode, outcome, true));
}

/**
 * POST order intents (okx.intent.v1). Gates run in order: auth, schema, live switch, insert (idempotency), TTL,
 * kill switch, risk limits, then price-based caps. Only then is OKX called. A request whose key was seen in the last
 * 10 minutes returns the stored result and never places a second order.
 */
export function createOrderSubmitHandler(deps: OrderSubmitDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[order-submit] ${message}`));

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.orderToken) return json(500, { error: "HIVE_ORDER_TOKEN is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.orderToken)) {
      return rejection(deps.mode, "rejected_auth", "unauthorized");
    }

    const text = await readBody(request);
    if (text === null) return rejection(deps.mode, "rejected_invalid", "body_too_large");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return rejection(deps.mode, "rejected_invalid", "body is not JSON");
    }

    const nowMs = now();
    const parsed = parseIntent(raw, nowMs);
    if (!parsed.ok) return rejection(deps.mode, "rejected_invalid", parsed.error);
    const intent = parsed.intent;

    if (deps.mode === "live" && !deps.liveEnabled) {
      return rejection(deps.mode, "rejected_risk", "live_disabled", intent);
    }

    const ids = clientOrderIds(intent.idempotencyKey);
    let inserted: InsertResult;
    try {
      inserted = await deps.store.insertIntent(toRecord(intent, ids, deps.mode, raw));
    } catch (error) {
      log(`intent insert failed key=${intent.idempotencyKey}: ${describeError(error)}`);
      return respond(
        fieldsFor(intent.intentId, intent.idempotencyKey, deps.mode, {
          ...terminal("exchange_error", "store_unavailable", ids.clOrdId),
          detail: describeError(error),
        }),
      );
    }
    if (!inserted.inserted) return replay(intent, inserted.existing, nowMs, deps.mode);

    let outcome: IntentOutcome;
    try {
      outcome = await execute(intent, ids, deps, nowMs);
    } catch (error) {
      outcome = { ...terminal("exchange_error", "hive_internal", ids.clOrdId), detail: describeError(error) };
    }

    try {
      await deps.store.finishIntent(intent.idempotencyKey, outcome);
    } catch (error) {
      log(`intent finish failed key=${intent.idempotencyKey}: ${describeError(error)}`);
    }
    log(
      `intent=${intent.intentId} action=${intent.action} inst=${intent.instId} status=${outcome.status} ` +
        `reason=${outcome.reason ?? "-"} ordId=${outcome.ordId ?? "-"} algoId=${outcome.algoId ?? "-"}`,
    );
    return respond(fieldsFor(intent.intentId, intent.idempotencyKey, deps.mode, outcome));
  };
}
