import { isAuthorized } from "./core/auth.ts";
import {
  formatToStep,
  type InstrumentSpec,
  managementKey,
  openIntent,
  roundToStep,
  type PositionMode,
} from "./core/position.ts";
import {
  evaluateReversalInvalidation,
  evaluateReversalSetup,
  evaluateReversalTrigger,
  parseStrategyParams,
  type ReversalLongParams,
  type ReversalSetup,
  reversalDailyBarsNeeded,
  reversalStopLevel,
} from "./core/strategy.ts";
import type { Candle } from "./core/types.ts";

export const SOURCE = "hive:strategy-evaluator";
export const INTENT_TTL_SEC = 120;
export const FIRE_LEASE_SEC = 300;
const DAY_MS = 86_400_000;
const FIFTEEN_MIN_MS = 900_000;
/** A series is stale when its newest confirmed bar is older than this many of its own intervals. */
const MAX_BAR_AGE_INTERVALS = 3;
/** Rejections that happened before OKX took any request. Anything else may have reached OKX and is treated as unknown. */
const NOTHING_PLACED_STATUSES = new Set(["rejected_risk", "rejected_auth", "rejected_invalid", "expired"]);
const NOTHING_PLACED_REASON = /^okx_rejected:|^store_unavailable$/;

export type OrderAction = "none" | "primed" | "reset" | "fired" | "failed" | "expired";

export interface ConditionalOrderRow {
  id: string;
  mode: PositionMode;
  instId: string;
  symbol: string;
  template: string;
  posSide: "net" | "long" | "short";
  tdMode: "isolated" | "cross";
  lever: number;
  /** Contract size as a decimal string, exactly as stored. */
  sz: string;
  theme: string;
  themeStopCapU: number;
  tpPct: number | null;
  params: unknown;
  status: "armed" | "primed";
  setupLow: number | null;
  setupLowTs: number | null;
  drawdownPct: number | null;
  invalidations: number;
  expiresAtMs: number;
}

export interface OrderPatch {
  lastEvalAt: string;
  lastNote: string;
  status?: "armed" | "primed" | "fired" | "expired" | "failed";
  setupLow?: number | null;
  setupLowTs?: string | null;
  setupAt?: string | null;
  refHigh?: number | null;
  drawdownPct?: number | null;
  invalidations?: number;
  fireBarTs?: string;
  fireTrigger?: string;
  firedAt?: string;
  ordId?: string | null;
  algoId?: string | null;
}

export interface AlertInsert {
  dedup_key: string;
  rule_id: null;
  symbol: string;
  kind: string;
  severity: "critical";
  payload: Record<string, unknown>;
}

export interface StrategyStore {
  killSwitchEngaged(): Promise<boolean>;
  listActiveOrders(mode: PositionMode): Promise<ConditionalOrderRow[]>;
  /** Most recent `limit` confirmed bars, ascending by ts. When sinceTs is set, only bars at or after it. */
  confirmedCandles(symbol: string, interval: "1D" | "15m", limit: number, sinceTs?: number): Promise<Candle[]>;
  recordEval(id: string, patch: OrderPatch): Promise<void>;
  claim(id: string, leaseSeconds: number): Promise<boolean>;
  insertAlert(alert: AlertInsert): Promise<void>;
}

export interface StrategyExchange {
  instrumentSpec(instId: string): Promise<InstrumentSpec>;
}

/** The order-submit response, reduced to what this handler needs. httpStatus is null when the call never got a response. */
export interface SubmitOutcome {
  httpStatus: number | null;
  status: string;
  reason: string | null;
  ordId: string | null;
  algoId: string | null;
  detail: string | null;
}

export interface OrderSubmitter {
  submit(intent: Record<string, unknown>): Promise<SubmitOutcome>;
}

export interface StrategyEvaluatorDeps {
  cronSecret: string | undefined;
  mode: PositionMode;
  liveEnabled: boolean;
  dryRun: boolean;
  store: StrategyStore;
  exchange: StrategyExchange;
  submitter: OrderSubmitter;
  now?: () => number;
  newIntentId?: () => string;
  log?: (message: string) => void;
}

export interface OrderReport {
  id: string;
  instId: string;
  action: OrderAction;
  notes: string[];
}

interface RunContext {
  deps: StrategyEvaluatorDeps;
  nowMs: number;
  newIntentId: () => string;
  log: (message: string) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function isNothingPlaced(outcome: SubmitOutcome): boolean {
  if (outcome.status === "exchange_error") return outcome.reason !== null && NOTHING_PLACED_REASON.test(outcome.reason);
  return NOTHING_PLACED_STATUSES.has(outcome.status);
}

function describeOutcome(outcome: SubmitOutcome): string {
  return `${outcome.status}${outcome.reason ? `:${outcome.reason}` : ""}`;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

interface FireResult {
  action: "fired" | "failed" | "none";
  note: string;
  patch: Partial<OrderPatch>;
}

/** Computes the fire terms, claims the lease and submits the open through order-submit. One shot: any submit outcome ends the order. */
async function fire(
  order: ConditionalOrderRow,
  params: ReversalLongParams,
  setup: ReversalSetup,
  trigger: { kind: string; barTs: number; close: number },
  ctx: RunContext,
): Promise<FireResult> {
  const { deps } = ctx;
  const spec = await deps.exchange.instrumentSpec(order.instId);
  const lots = Math.floor(Number(order.sz) / spec.lotSz + 1e-9);
  const effSz = lots * spec.lotSz;
  if (!(effSz > 0) || effSz < spec.minSz) {
    return { action: "failed", note: `size_below_min:sz=${order.sz}:lot=${spec.lotSz}:min=${spec.minSz}`, patch: { status: "failed" } };
  }
  const stopLevel = reversalStopLevel(setup.setupLow, params.stopBufferPct);
  const sl = roundToStep(stopLevel, spec.tickSz);
  if (!(sl > 0) || sl >= trigger.close) {
    return { action: "none", note: `stop_not_below_close:sl=${sl}:close=${trigger.close}`, patch: {} };
  }
  const slTriggerPx = formatToStep(sl, spec.tickSz);
  const tpTriggerPx =
    order.tpPct !== null ? formatToStep(roundToStep(trigger.close * (1 + order.tpPct / 100), spec.tickSz), spec.tickSz) : null;
  const sz = formatToStep(effSz, spec.lotSz);
  const reason =
    `reversal_long fired trigger=${trigger.kind} bar=${new Date(trigger.barTs).toISOString()} ` +
    `setup_low=${setup.setupLow} drawdown=${round2(setup.drawdownPct)}%`;

  if (deps.dryRun) {
    return { action: "none", note: `dry_run:fire:${trigger.kind}:sz=${sz}:sl=${slTriggerPx}:tp=${tpTriggerPx ?? "none"}`, patch: {} };
  }

  const claimed = await deps.store.claim(order.id, FIRE_LEASE_SEC);
  if (!claimed) return { action: "none", note: "fire_claimed_elsewhere", patch: {} };

  const outcome = await deps.submitter.submit(
    openIntent({
      intentId: ctx.newIntentId(),
      idempotencyKey: managementKey(["conditional", order.id, trigger.barTs]),
      createdAt: new Date(ctx.nowMs).toISOString(),
      source: SOURCE,
      instId: order.instId,
      direction: "long",
      posSide: order.posSide,
      tdMode: order.tdMode,
      lever: order.lever,
      sz,
      slTriggerPx,
      tpTriggerPx,
      theme: order.theme,
      themeStopCapU: order.themeStopCapU,
      reason,
      ttlSec: INTENT_TTL_SEC,
    }),
  );

  const alertBase = {
    rule_id: null,
    symbol: order.symbol,
    severity: "critical" as const,
    payload: {
      source: SOURCE,
      order_id: order.id,
      inst_id: order.instId,
      trigger: trigger.kind,
      bar_ts: new Date(trigger.barTs).toISOString(),
      close: trigger.close,
      setup_low: setup.setupLow,
      sl_trigger_px: slTriggerPx,
    },
  };

  if (outcome.status === "acked") {
    await deps.store
      .insertAlert({
        ...alertBase,
        dedup_key: `conditional:${order.id}:fired`,
        kind: "conditional_order_fired",
        payload: { ...alertBase.payload, ord_id: outcome.ordId, algo_id: outcome.algoId },
      })
      .catch((error: unknown) => ctx.log(`order=${order.id} alert insert failed: ${describeError(error)}`));
    return {
      action: "fired",
      note: `fired:${trigger.kind}:sz=${sz}:sl=${slTriggerPx}:${outcome.ordId ?? outcome.algoId ?? "-"}`,
      patch: {
        status: "fired",
        fireBarTs: new Date(trigger.barTs).toISOString(),
        fireTrigger: trigger.kind,
        firedAt: new Date(ctx.nowMs).toISOString(),
        ordId: outcome.ordId,
        algoId: outcome.algoId,
      },
    };
  }

  const placed = !isNothingPlaced(outcome);
  const note = placed
    ? `fire_unknown_outcome:${describeOutcome(outcome)}:check_okx`
    : `fire_rejected:${describeOutcome(outcome)}`;
  await deps.store
    .insertAlert({
      ...alertBase,
      dedup_key: `conditional:${order.id}:failed`,
      kind: "conditional_order_failed",
      payload: { ...alertBase.payload, outcome: describeOutcome(outcome) },
    })
    .catch((error: unknown) => ctx.log(`order=${order.id} alert insert failed: ${describeError(error)}`));
  return { action: "failed", note, patch: { status: "failed" } };
}

/**
 * One order, one cycle. The state machine: armed watches for the setup; primed watches for the trigger,
 * discards the setup when it goes stale or a daily close breaks the stop level (back to armed, counted as
 * an invalidation), and fires exactly once. Every non-terminal outcome is recorded on the row.
 */
async function evaluateOrder(order: ConditionalOrderRow, ctx: RunContext): Promise<OrderReport> {
  const { deps, nowMs } = ctx;
  const notes: string[] = [];
  let action: OrderAction = "none";
  const patch: OrderPatch = { lastEvalAt: new Date(nowMs).toISOString(), lastNote: "" };
  const conclude = async (): Promise<OrderReport> => {
    patch.lastNote = notes.length > 0 ? notes.join("; ").slice(0, 500) : "ok";
    if (!deps.dryRun) {
      await deps.store.recordEval(order.id, patch);
    }
    ctx.log(`order=${order.id} inst=${order.instId} action=${action} notes=${patch.lastNote}`);
    return { id: order.id, instId: order.instId, action, notes };
  };

  let params: ReversalLongParams;
  try {
    params = parseStrategyParams(order.template, order.params);
  } catch (error) {
    notes.push(`invalid_params:${describeError(error)}`);
    return conclude();
  }

  if (nowMs > order.expiresAtMs) {
    patch.status = "expired";
    action = "expired";
    notes.push("expired");
    return conclude();
  }

  const daily = await deps.store.confirmedCandles(order.symbol, "1D", reversalDailyBarsNeeded(params) + 5);
  const lastDaily = daily[daily.length - 1];
  if (!lastDaily || daily.length < params.lookbackDays) {
    notes.push(`insufficient_daily_bars:${daily.length}`);
    return conclude();
  }
  if (nowMs - lastDaily.ts > MAX_BAR_AGE_INTERVALS * DAY_MS) {
    notes.push("stale_daily");
    return conclude();
  }

  let status = order.status;
  let setup: ReversalSetup | null =
    status === "primed" && order.setupLow !== null && order.setupLowTs !== null
      ? {
          setupLow: order.setupLow,
          setupLowTs: order.setupLowTs,
          refHigh: 0,
          drawdownPct: order.drawdownPct ?? 0,
          windowMinRsi: null,
        }
      : null;

  if (status === "primed" && setup) {
    const stopLevel = reversalStopLevel(setup.setupLow, params.stopBufferPct);
    if (nowMs - setup.setupLowTs > params.setupMaxAgeDays * DAY_MS) {
      notes.push("setup_stale:reset");
      setup = null;
      status = "armed";
      action = "reset";
      Object.assign(patch, { status: "armed", setupLow: null, setupLowTs: null, setupAt: null, refHigh: null, drawdownPct: null });
    } else if (evaluateReversalInvalidation(daily, setup, stopLevel)) {
      notes.push(`setup_invalidated:close_below:${round2(stopLevel)}`);
      setup = null;
      status = "armed";
      action = "reset";
      patch.invalidations = order.invalidations + 1;
      Object.assign(patch, { status: "armed", setupLow: null, setupLowTs: null, setupAt: null, refHigh: null, drawdownPct: null });
    }
  }

  if (status === "armed") {
    const found = evaluateReversalSetup(daily, params);
    if (found) {
      setup = found;
      status = "primed";
      action = action === "reset" ? "reset" : "primed";
      notes.push(
        `primed low=${found.setupLow}@${new Date(found.setupLowTs).toISOString().slice(0, 10)} ` +
          `dd=${round2(found.drawdownPct)}% rsi=${found.windowMinRsi === null ? "-" : round2(found.windowMinRsi)}`,
      );
      Object.assign(patch, {
        status: "primed",
        setupLow: found.setupLow,
        setupLowTs: new Date(found.setupLowTs).toISOString(),
        setupAt: new Date(nowMs).toISOString(),
        refHigh: found.refHigh,
        drawdownPct: round2(found.drawdownPct),
      });
    } else {
      const lookback = daily.slice(daily.length - params.lookbackDays);
      const window = daily.slice(daily.length - params.setupWindowDays);
      const refHigh = Math.max(...lookback.map((bar) => bar.high));
      const winLow = Math.min(...window.map((bar) => bar.low));
      notes.push(`watching dd=${round2(((refHigh - winLow) / refHigh) * 100)}% need>=${params.minDrawdownPct}%`);
      return conclude();
    }
  }

  if (!setup) return conclude();

  const triggerBars =
    params.interval === "1D"
      ? daily
      : await deps.store.confirmedCandles(order.symbol, "15m", 2000, setup.setupLowTs);
  const lastBar = triggerBars[triggerBars.length - 1];
  const intervalMs = params.interval === "1D" ? DAY_MS : FIFTEEN_MIN_MS;
  if (!lastBar || nowMs - lastBar.ts > MAX_BAR_AGE_INTERVALS * intervalMs) {
    notes.push(`stale_trigger_bars:${params.interval}`);
    return conclude();
  }

  const trigger = evaluateReversalTrigger(triggerBars, params, setup);
  if (!trigger) {
    notes.push(`primed_waiting low=${setup.setupLow}`);
    return conclude();
  }

  const result = await fire(order, params, setup, trigger, ctx);
  notes.push(result.note);
  Object.assign(patch, result.patch);
  if (result.action !== "none") action = result.action;
  return conclude();
}

/**
 * Cron entry point (EDGE_CRON_SECRET). Every active conditional order for the mode is evaluated in
 * isolation. Fires go through order-submit, so the kill switch and risk gates apply to every order.
 */
export function createStrategyEvaluatorHandler(deps: StrategyEvaluatorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[strategy-evaluator] ${message}`));
  const newIntentId = deps.newIntentId ?? (() => `co-${crypto.randomUUID()}`);

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const started = now();
    if (deps.mode === "live" && !deps.liveEnabled) {
      return json(200, { status: "disabled", reason: "live_disabled", mode: deps.mode });
    }

    let engaged: boolean;
    let orders: ConditionalOrderRow[];
    try {
      engaged = await deps.store.killSwitchEngaged();
      orders = engaged ? [] : await deps.store.listActiveOrders(deps.mode);
    } catch (error) {
      const message = `conditional order read failed: ${describeError(error)}`;
      log(message);
      return json(500, { error: message });
    }
    if (engaged) return json(200, { status: "skipped", reason: "kill_switch_engaged", mode: deps.mode });

    const reports: OrderReport[] = [];
    for (const order of orders) {
      const ctx: RunContext = { deps, nowMs: now(), newIntentId, log };
      try {
        reports.push(await evaluateOrder(order, ctx));
      } catch (error) {
        const note = `error:${describeError(error)}`;
        log(`order=${order.id} inst=${order.instId} ${note}`);
        reports.push({ id: order.id, instId: order.instId, action: "none", notes: [note] });
        if (!deps.dryRun) {
          await deps.store
            .recordEval(order.id, { lastEvalAt: new Date(ctx.nowMs).toISOString(), lastNote: note })
            .catch((recordError: unknown) => log(`order=${order.id} eval record failed: ${describeError(recordError)}`));
        }
      }
    }

    return json(200, {
      status: "ok",
      mode: deps.mode,
      dryRun: deps.dryRun,
      orders: orders.length,
      reports,
      durationMs: now() - started,
    });
  };
}
