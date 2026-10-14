import { isAuthorized } from "./core/auth.ts";
import { computeAtr } from "./core/atr.ts";
import {
  actionBucket,
  amendIntent,
  closingSide,
  dynamicTakeProfit,
  formatToStep,
  halfReduceSize,
  halfWayFailed,
  type InstrumentSpec,
  managementKey,
  matchPosition,
  MIN_TP_MARK_FRACTION,
  type PendingAlgo,
  type PositionMode,
  type PositionRow,
  type PositionSubscription,
  reduceIntent,
  roundToStep,
  selectProtection,
  tpBeyondMark,
  tpDeviationAtr,
} from "./core/position.ts";
import type { Candle } from "./core/types.ts";

export const SOURCE = "hive:position-manager";
export const INTENT_TTL_SEC = 120;
export const HALF_REDUCE_LEASE_SEC = 300;
const HOURLY_MAX_AGE_MS = 3 * 3_600_000;
const FIVE_MINUTE_MAX_AGE_MS = 15 * 60_000;
/** Rejections that happened before OKX took any request. Anything else may have reached OKX and is treated as unknown. */
const NOTHING_PLACED_STATUSES = new Set(["rejected_risk", "rejected_auth", "rejected_invalid", "expired"]);
const NOTHING_PLACED_REASON = /^okx_rejected:|^store_unavailable$/;

export type Action = "none" | "reduce" | "amend" | "reduce+amend";

export interface EvalPatch {
  lastEvalAt: string;
  lastNote: string;
  tpPx?: number;
  lastAmendAt?: string;
}

export interface PositionStore {
  killSwitchEngaged(): Promise<boolean>;
  listEnabledSubscriptions(mode: PositionMode): Promise<PositionSubscription[]>;
  recordEval(id: string, patch: EvalPatch): Promise<void>;
  claimHalfReduce(id: string, leaseSeconds: number): Promise<boolean>;
  finishHalfReduce(id: string, outcome: { done: boolean; note: string; reduced: boolean }): Promise<void>;
}

export interface PositionExchange {
  positions(instId: string): Promise<PositionRow[]>;
  protectionAlgos(instId: string): Promise<PendingAlgo[]>;
  instrumentSpec(instId: string): Promise<InstrumentSpec>;
  /** Confirmed bars only, ascending by ts. */
  confirmedCandles(instId: string, bar: "1H" | "5m", limit: number): Promise<Candle[]>;
  cancelAlgos(items: { algoId: string; instId: string }[]): Promise<void>;
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

export interface PositionManagerDeps {
  cronSecret: string | undefined;
  mode: PositionMode;
  liveEnabled: boolean;
  dryRun: boolean;
  store: PositionStore;
  exchange: PositionExchange;
  submitter: OrderSubmitter;
  now?: () => number;
  newIntentId?: () => string;
  log?: (message: string) => void;
}

export interface SubscriptionReport {
  id: string;
  instId: string;
  action: Action;
  notes: string[];
}

interface RunContext {
  deps: PositionManagerDeps;
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

async function halfReduce(
  sub: PositionSubscription,
  sz: string,
  ctx: RunContext,
): Promise<{ reduced: boolean; note: string }> {
  const { deps } = ctx;
  const claimed = await deps.store.claimHalfReduce(sub.id, HALF_REDUCE_LEASE_SEC);
  if (!claimed) return { reduced: false, note: "half_reduce_claimed_elsewhere" };

  // Not time-bucketed on purpose: a once-only reduce must return the stored result on a retry, never a second order.
  // The attempt counter moves only after an attempt that placed nothing, so a later retry gets a fresh key.
  const outcome = await deps.submitter.submit(
    reduceIntent({
      intentId: ctx.newIntentId(),
      idempotencyKey: managementKey(["reduce", sub.id, sub.entryPx, sz, sub.halfReduceAttempts]),
      createdAt: new Date(ctx.nowMs).toISOString(),
      source: SOURCE,
      instId: sub.instId,
      direction: sub.direction,
      posSide: sub.posSide,
      tdMode: sub.tdMode,
      sz,
      reason: `half_way_invalidate mid=${sub.midPx}`,
      ttlSec: INTENT_TTL_SEC,
    }),
  );

  if (outcome.status === "acked") {
    const note = `half_reduce_acked:${sz}:${outcome.ordId ?? outcome.algoId ?? "-"}`;
    await deps.store.finishHalfReduce(sub.id, { done: true, note, reduced: true });
    return { reduced: true, note };
  }
  if (isNothingPlaced(outcome)) {
    const note = `half_reduce_rejected:${describeOutcome(outcome)}`;
    await deps.store.finishHalfReduce(sub.id, { done: false, note, reduced: false });
    return { reduced: false, note };
  }
  const note = `half_reduce_unknown_outcome:${describeOutcome(outcome)}:check_okx`;
  await deps.store.finishHalfReduce(sub.id, { done: true, note, reduced: false });
  return { reduced: false, note };
}

/**
 * One subscription, one cycle. Half-way reduce runs first and only once. Then the protective stop is replaced when the
 * take-profit has moved or the position size changed. The stop itself is re-sent unchanged. Leftover reduce-only stops
 * on the closing side are cancelled after the new one is acked.
 */
async function manageSubscription(sub: PositionSubscription, ctx: RunContext): Promise<SubscriptionReport> {
  const { deps, nowMs } = ctx;
  const notes: string[] = [];
  const conclude = async (action: Action, extra: { tpPx?: number; lastAmendAt?: string } = {}): Promise<SubscriptionReport> => {
    const lastNote = notes.length > 0 ? notes.join("; ") : "ok";
    if (!deps.dryRun) {
      await deps.store.recordEval(sub.id, { lastEvalAt: new Date(nowMs).toISOString(), lastNote, ...extra });
    }
    ctx.log(`sub=${sub.id} inst=${sub.instId} action=${action} notes=${lastNote}`);
    return { id: sub.id, instId: sub.instId, action, notes };
  };

  const match = matchPosition(await deps.exchange.positions(sub.instId), sub);
  if (match.kind === "none") {
    notes.push("no_position");
    return conclude("none");
  }
  if (match.kind === "skip") {
    notes.push(`skip:${match.reason}`);
    return conclude("none");
  }
  let size = match.size;
  let markPx = match.markPx;

  const spec = await deps.exchange.instrumentSpec(sub.instId);
  const hourly = await deps.exchange.confirmedCandles(sub.instId, "1H", 100);
  const lastHour = hourly[hourly.length - 1];
  if (!lastHour || nowMs - lastHour.ts > HOURLY_MAX_AGE_MS || hourly.length < sub.atrLen + 1) {
    notes.push("skip:stale_or_short_1h");
    return conclude("none");
  }
  const atr = computeAtr(hourly, sub.atrLen).atr;
  if (!(atr > 0)) {
    notes.push("skip:atr_not_positive");
    return conclude("none");
  }

  const fives = await deps.exchange.confirmedCandles(sub.instId, "5m", 3);
  const lastFive = fives[fives.length - 1];
  const fiveFresh = lastFive !== undefined && nowMs - lastFive.ts <= FIVE_MINUTE_MAX_AGE_MS;

  const protection = selectProtection(await deps.exchange.protectionAlgos(sub.instId), sub.direction, sub.posSide);
  if (!protection || protection.slTriggerPx === null) {
    notes.push("skip:no_exchange_stop");
    return conclude("none");
  }

  let reduced = false;
  if (sub.halfReduceEnabled && !sub.halfReduceDone) {
    if (!lastFive || !fiveFresh) {
      notes.push("skip:stale_5m");
    } else if (halfWayFailed(sub.direction, sub.midPx, lastFive.close)) {
      const sz = halfReduceSize(size, spec.lotSz, spec.minSz, sub.halfReduceFrac);
      if (sz === null) {
        notes.push("half_reduce_below_min_size");
      } else if (ctx.deps.dryRun) {
        notes.push(`dry_run:half_reduce:${sz}`);
      } else {
        const result = await halfReduce(sub, sz, ctx);
        notes.push(result.note);
        reduced = result.reduced;
        if (reduced) {
          const after = matchPosition(await deps.exchange.positions(sub.instId), sub);
          if (after.kind !== "ok") {
            notes.push("post_reduce_position_unavailable");
            return conclude("reduce");
          }
          size = after.size;
          markPx = after.markPx;
        }
      }
    }
  }

  const currentTp = protection.tpTriggerPx === null ? null : Number(protection.tpTriggerPx);
  let tpTarget: number | null = null;
  if (sub.dynamicTpEnabled) {
    const candidate = roundToStep(dynamicTakeProfit(sub.direction, sub.entryPx, atr, sub.atrMult), spec.tickSz);
    if (tpDeviationAtr(candidate, currentTp, atr) >= sub.amendMinAtrFrac) {
      if (candidate > 0 && tpBeyondMark(sub.direction, candidate, markPx, MIN_TP_MARK_FRACTION)) {
        tpTarget = candidate;
      } else {
        notes.push("tp_not_beyond_mark");
      }
    }
  }

  const resize = Math.abs(protection.sz - size) > 1e-9;
  if (tpTarget === null && !resize) {
    notes.push("no_change");
    return conclude(reduced ? "reduce" : "none");
  }
  if (size < spec.minSz) {
    notes.push("skip:size_below_min");
    return conclude(reduced ? "reduce" : "none");
  }

  const sz = formatToStep(size, spec.lotSz);
  const slTriggerPx = protection.slTriggerPx;
  const tpTriggerPx = tpTarget !== null ? formatToStep(tpTarget, spec.tickSz) : protection.tpTriggerPx;
  const tpOrdPx = tpTarget !== null ? "-1" : protection.tpOrdPx;
  const reason = [tpTarget !== null ? `dynamic_tp=${tpTriggerPx}` : null, resize ? `resize=${sz}` : null]
    .filter((part): part is string => part !== null)
    .join(" ");
  const idempotencyKey = managementKey(["amend_tpsl", sub.id, sz, slTriggerPx, tpTriggerPx ?? "", actionBucket(nowMs)]);
  const action: Action = reduced ? "reduce+amend" : "amend";

  if (ctx.deps.dryRun) {
    notes.push(`dry_run:amend:sz=${sz}:tp=${tpTriggerPx ?? "none"}`);
    return conclude(reduced ? "reduce" : "none");
  }

  const outcome = await deps.submitter.submit(
    amendIntent({
      intentId: ctx.newIntentId(),
      idempotencyKey,
      createdAt: new Date(nowMs).toISOString(),
      source: SOURCE,
      instId: sub.instId,
      direction: sub.direction,
      posSide: sub.posSide,
      tdMode: sub.tdMode,
      sz,
      slTriggerPx,
      slOrdPx: protection.slOrdPx ?? "-1",
      tpTriggerPx,
      tpOrdPx,
      reason,
      ttlSec: INTENT_TTL_SEC,
    }),
  );

  if (outcome.status === "acked" && outcome.algoId !== null) {
    const side = closingSide(sub.direction);
    const leftovers = (await deps.exchange.protectionAlgos(sub.instId)).filter(
      (algo) =>
        algo.algoId !== outcome.algoId &&
        algo.reduceOnly &&
        algo.side === side &&
        (sub.posSide === "net" || algo.posSide === sub.posSide),
    );
    if (leftovers.length > 0) {
      try {
        await deps.exchange.cancelAlgos(leftovers.map((algo) => ({ algoId: algo.algoId, instId: sub.instId })));
        notes.push(`cancelled_leftover:${leftovers.map((algo) => algo.algoId).join(",")}`);
      } catch (error) {
        notes.push(`leftover_cancel_failed:${describeError(error)}`);
      }
    }
    notes.push(`amend_acked:${outcome.algoId}:${reason}`);
    return conclude(action, {
      lastAmendAt: new Date(nowMs).toISOString(),
      ...(tpTarget !== null ? { tpPx: tpTarget } : {}),
    });
  }

  notes.push(isNothingPlaced(outcome) ? `amend_rejected:${describeOutcome(outcome)}` : `amend_unknown:${describeOutcome(outcome)}`);
  return conclude(reduced ? "reduce" : "none");
}

/**
 * Cron entry point (EDGE_CRON_SECRET). Every enabled subscription for the mode is evaluated. Each one is isolated, so an
 * error in one never stops the others. The order-submit path enforces the kill switch and risk gates on every action.
 */
export function createPositionManagerHandler(deps: PositionManagerDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[position-manager] ${message}`));
  const newIntentId = deps.newIntentId ?? (() => `pm-${crypto.randomUUID()}`);

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
    let subscriptions: PositionSubscription[];
    try {
      engaged = await deps.store.killSwitchEngaged();
      subscriptions = engaged ? [] : await deps.store.listEnabledSubscriptions(deps.mode);
    } catch (error) {
      const message = `subscription read failed: ${describeError(error)}`;
      log(message);
      return json(500, { error: message });
    }
    if (engaged) return json(200, { status: "skipped", reason: "kill_switch_engaged", mode: deps.mode });

    const reports: SubscriptionReport[] = [];
    for (const sub of subscriptions) {
      const ctx: RunContext = { deps, nowMs: now(), newIntentId, log };
      try {
        reports.push(await manageSubscription(sub, ctx));
      } catch (error) {
        const note = `error:${describeError(error)}`;
        log(`sub=${sub.id} inst=${sub.instId} ${note}`);
        reports.push({ id: sub.id, instId: sub.instId, action: "none", notes: [note] });
        if (!deps.dryRun) {
          await deps.store
            .recordEval(sub.id, { lastEvalAt: new Date(ctx.nowMs).toISOString(), lastNote: note })
            .catch((recordError: unknown) => log(`sub=${sub.id} eval record failed: ${describeError(recordError)}`));
        }
      }
    }

    return json(200, {
      status: "ok",
      mode: deps.mode,
      dryRun: deps.dryRun,
      subscriptions: subscriptions.length,
      reports,
      durationMs: now() - started,
    });
  };
}
