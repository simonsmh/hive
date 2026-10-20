import { isAuthorized } from "./core/auth.ts";
import {
  actionBucket,
  amendIntent,
  closeIntent,
  formatToStep,
  type InstrumentSpec,
  managementKey,
  openIntent,
  type PendingAlgo,
  type PositionMode,
  type PositionRow,
  roundToStep,
} from "./core/position.ts";
import {
  computeTrendSize,
  evaluateTrendExit,
  evaluateTrendTrigger,
  parseTrendParams,
  parseTrendState,
  planAlgoReconcile,
  planTrendAdd,
  protectiveAlgos,
  TREND_BAR_MS,
  trendBarsNeeded,
  trendInitialStop,
  type TrendDirection,
  type TrendParams,
  type TrendRuntimeState,
} from "./core/trend.ts";
import type { Candle } from "./core/types.ts";

export const SOURCE = "hive:trend-evaluator";
export const INTENT_TTL_SEC = 120;
export const ACTION_LEASE_SEC = 300;
/** A series is stale when its newest confirmed bar is older than this many of its own intervals. */
const MAX_BAR_AGE_INTERVALS = 3;
/** Rejections that happened before OKX took any request. Anything else may have reached OKX and is treated as unknown. */
const NOTHING_PLACED_STATUSES = new Set(["rejected_risk", "rejected_auth", "rejected_invalid", "expired"]);
const NOTHING_PLACED_REASON = /^okx_rejected:|^store_unavailable$/;

export type TrendAction =
  | "none"
  | "opened"
  | "added"
  | "exited"
  | "done"
  | "expired"
  | "failed";

export interface TrendInstanceRow {
  id: string;
  mode: PositionMode;
  runMode: "shadow" | "live";
  instId: string;
  symbol: string;
  direction: TrendDirection;
  posSide: "net" | "long" | "short";
  tdMode: "isolated" | "cross";
  lever: number;
  /** First unit size as a decimal string, exactly as stored. */
  firstSz: string;
  theme: string;
  themeStopCapU: number;
  params: unknown;
  state: unknown;
  status: "armed" | "active" | "done" | "expired" | "cancelled" | "failed";
  expiresAtMs: number;
}

export interface TrendPatch {
  lastEvalAt: string;
  lastNote: string;
  status?: "active" | "done" | "expired" | "failed";
  state?: TrendRuntimeState;
}

export interface TrendEventInsert {
  instanceId: string;
  kind: string;
  detail: Record<string, unknown>;
}

export interface AlertInsert {
  dedup_key: string;
  rule_id: null;
  symbol: string;
  kind: string;
  severity: "critical";
  payload: Record<string, unknown>;
}

export interface TrendStore {
  killSwitchEngaged(): Promise<boolean>;
  listActiveInstances(mode: PositionMode): Promise<TrendInstanceRow[]>;
  /** Most recent `limit` confirmed bars, ascending by ts. */
  confirmedCandles(symbol: string, interval: "5m", limit: number): Promise<Candle[]>;
  recordEval(id: string, patch: TrendPatch): Promise<void>;
  claim(id: string, leaseSeconds: number): Promise<boolean>;
  /** Fresh read of one instance, used to re-verify liveness after an action claim (cancel race guard). */
  getInstance(id: string): Promise<TrendInstanceRow | null>;
  insertEvent(event: TrendEventInsert): Promise<void>;
  insertAlert(alert: AlertInsert): Promise<void>;
}

export interface AccountState {
  positions: PositionRow[];
  algos: PendingAlgo[];
}

export interface TrendExchange {
  instrumentSpec(instId: string): Promise<InstrumentSpec>;
  /** Live account read (order-sync GET): positions and pending algos for the instrument. */
  accountState(instId: string): Promise<AccountState>;
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

export interface TrendEvaluatorDeps {
  cronSecret: string | undefined;
  mode: PositionMode;
  liveEnabled: boolean;
  /** Global dry run: every instance behaves as shadow and nothing is written back. */
  dryRun: boolean;
  store: TrendStore;
  exchange: TrendExchange;
  submitter: OrderSubmitter;
  now?: () => number;
  newIntentId?: () => string;
  log?: (message: string) => void;
}

export interface InstanceReport {
  id: string;
  instId: string;
  action: TrendAction;
  notes: string[];
}

interface RunContext {
  deps: TrendEvaluatorDeps;
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

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** The instance's own position row: net mode reads the net row; direction must match the instance. */
function findPosition(account: AccountState, instance: TrendInstanceRow): PositionRow | null {
  const row = account.positions.find((candidate) =>
    instance.posSide === "net" ? candidate.posSide === "net" : candidate.posSide === instance.posSide,
  );
  if (!row || row.pos === 0 || !Number.isFinite(row.pos)) return null;
  if (instance.posSide === "net") {
    const observed = row.pos > 0 ? "long" : "short";
    if (observed !== instance.direction) return null;
  }
  return row;
}

/**
 * Converges the exchange's protective algos to (totalSize at stopPx) after an action. The plan comes
 * from core; execution is: one amend_tpsl through order-submit (which replaces the instrument's
 * recorded algos), then a direct cancel of any protective leftover the amend did not own (the
 * position-manager precedent), then a fresh read whose plan must be empty. Returns the final plan
 * length (0 = converged) and human notes.
 */
async function convergeProtection(
  instance: TrendInstanceRow,
  ctx: RunContext,
  events: TrendEventInsert[],
  totalSize: number,
  stopPx: number,
  spec: InstrumentSpec,
): Promise<{ converged: boolean; notes: string[] }> {
  const { deps } = ctx;
  const notes: string[] = [];
  const desired = { size: totalSize, stopPx, lotSz: spec.lotSz, tickSz: spec.tickSz };
  let account = await deps.exchange.accountState(instance.instId);
  let plan = planAlgoReconcile(desired, account.algos, instance.direction, instance.posSide);
  if (plan.length === 0) return { converged: true, notes };

  for (const action of plan) {
    if (action.kind === "cancel_algos") {
      await deps.exchange.cancelAlgos(action.algoIds.map((algoId) => ({ algoId, instId: instance.instId })));
      notes.push(`cancelled_orphans:${action.algoIds.join(",")}`);
      events.push({
        instanceId: instance.id,
        kind: "orphan_algos_cancelled",
        detail: { algoIds: action.algoIds },
      });
    } else {
      events.push({
        instanceId: instance.id,
        kind: "reconcile_planned",
        detail: { action: "amend_tpsl", sz: action.sz, slTriggerPx: action.slTriggerPx },
      });
      const outcome = await deps.submitter.submit(
        amendIntent({
          intentId: ctx.newIntentId(),
          idempotencyKey: managementKey(["trend-reconcile", instance.id, action.sz, action.slTriggerPx, actionBucket(ctx.nowMs)]),
          createdAt: new Date(ctx.nowMs).toISOString(),
          source: SOURCE,
          instId: instance.instId,
          direction: instance.direction,
          posSide: instance.posSide,
          tdMode: instance.tdMode,
          sz: action.sz,
          slTriggerPx: action.slTriggerPx,
          slOrdPx: "-1",
          tpTriggerPx: null,
          tpOrdPx: null,
          reason: `trend_follow reconcile stop=${action.slTriggerPx} sz=${action.sz}`,
          ttlSec: INTENT_TTL_SEC,
        }),
      );
      if (outcome.status !== "acked" || outcome.algoId === null) {
        notes.push(`reconcile_amend_failed:${describeOutcome(outcome)}`);
        events.push({ instanceId: instance.id, kind: "reconcile_failed", detail: { outcome: describeOutcome(outcome) } });
        return { converged: false, notes };
      }
      notes.push(`reconcile_amend:${outcome.algoId}`);
      // The amend replaces algos recorded in the orders table; anything protective that is not the new
      // algo (placed outside order-submit) is cancelled directly, like position-manager does.
      const after = await deps.exchange.accountState(instance.instId);
      const leftovers = protectiveAlgos(after.algos, instance.direction, instance.posSide).filter(
        (algo) => algo.algoId !== outcome.algoId,
      );
      if (leftovers.length > 0) {
        await deps.exchange.cancelAlgos(leftovers.map((algo) => ({ algoId: algo.algoId, instId: instance.instId })));
        notes.push(`cancelled_leftovers:${leftovers.map((algo) => algo.algoId).join(",")}`);
      }
    }
  }

  account = await deps.exchange.accountState(instance.instId);
  plan = planAlgoReconcile(desired, account.algos, instance.direction, instance.posSide);
  const converged = plan.length === 0;
  events.push({
    instanceId: instance.id,
    kind: converged ? "reconciled" : "reconcile_failed",
    detail: { desiredSize: totalSize, desiredStop: stopPx, remainingPlan: plan },
  });
  if (!converged) notes.push("reconcile_incomplete");
  return { converged, notes };
}

/**
 * One instance, one cycle. Decisions are per confirmed 5m bar: a minute without a new bar is a no-op
 * that writes nothing. armed evaluates the composed trigger; active tracks the position (observed on
 * OKX for live, simulated from closes for shadow), exits on ATR decay / MA cross, pyramids on ATR
 * steps, and keeps the unified stop converged. Shadow instances run the identical state machine with
 * simulated fills and never touch order-submit.
 */
async function evaluateInstance(instance: TrendInstanceRow, ctx: RunContext): Promise<InstanceReport> {
  const { deps, nowMs } = ctx;
  const notes: string[] = [];
  const events: TrendEventInsert[] = [];
  let action: TrendAction = "none";
  const patch: TrendPatch = { lastEvalAt: new Date(nowMs).toISOString(), lastNote: "" };
  let state = parseTrendState(instance.state);
  let dirty = false;
  const shadow = instance.runMode === "shadow" || deps.dryRun;

  const conclude = async (): Promise<InstanceReport> => {
    patch.lastNote = notes.length > 0 ? notes.join("; ").slice(0, 500) : "ok";
    if (!deps.dryRun && dirty) {
      await deps.store.recordEval(instance.id, patch);
      for (const event of events) {
        await deps.store
          .insertEvent(event)
          .catch((error: unknown) => ctx.log(`instance=${instance.id} event insert failed: ${describeError(error)}`));
      }
    }
    ctx.log(`instance=${instance.id} inst=${instance.instId} mode=${instance.runMode} action=${action} notes=${patch.lastNote}`);
    return { id: instance.id, instId: instance.instId, action, notes };
  };
  const emit = (kind: string, detail: Record<string, unknown>): void => {
    events.push({ instanceId: instance.id, kind, detail });
    dirty = true;
  };
  const alert = async (kind: string, payload: Record<string, unknown>): Promise<void> => {
    if (deps.dryRun) return;
    await deps.store
      .insertAlert({
        dedup_key: `trend:${instance.id}:${kind}`,
        rule_id: null,
        symbol: instance.symbol,
        kind,
        severity: "critical",
        payload: { source: SOURCE, instance_id: instance.id, inst_id: instance.instId, ...payload },
      })
      .catch((error: unknown) => ctx.log(`instance=${instance.id} alert insert failed: ${describeError(error)}`));
  };

  let params: TrendParams;
  try {
    params = parseTrendParams(instance.params);
  } catch (error) {
    notes.push(`invalid_params:${describeError(error)}`);
    dirty = true;
    return conclude();
  }

  const bars = await deps.store.confirmedCandles(instance.symbol, "5m", trendBarsNeeded(params));
  const lastBar = bars[bars.length - 1];
  if (!lastBar || nowMs - lastBar.ts > MAX_BAR_AGE_INTERVALS * TREND_BAR_MS) {
    const marker = lastBar?.ts ?? 0;
    if (marker !== (state.lastEvalBarTs ?? -1)) {
      emit("eval_skip", { reason: lastBar ? "stale_bars" : "no_bars", lastBarTs: lastBar?.ts ?? null });
      state = { ...state, lastEvalBarTs: marker === 0 ? state.lastEvalBarTs : marker };
      patch.state = state;
    }
    notes.push(lastBar ? "stale_bars" : "no_bars");
    return conclude();
  }

  // Expiry: an armed instance simply ends; an active one is closed out first, then ends. If the
  // close cannot be completed the instance stays active past its expiry and retries next cycle —
  // expiring it anyway would leave a live position with no manager.
  if (nowMs > instance.expiresAtMs) {
    if (instance.status === "active" && (shadow ? state.positionSz > 0 : true)) {
      const closed = await closeOut(instance, ctx, {
        shadow,
        state,
        lastBar,
        reason: "expired",
        events,
        notes,
        alert,
      });
      if (!closed) {
        notes.push("expiry_close_pending:stays_active");
        return conclude();
      }
      state = closed;
      patch.state = state;
    }
    patch.status = "expired";
    action = "expired";
    emit("expired", { wasActive: instance.status === "active" });
    return conclude();
  }

  if (state.lastEvalBarTs === lastBar.ts) {
    notes.push("no_new_bar");
    return { id: instance.id, instId: instance.instId, action, notes };
  }
  state = { ...state, lastEvalBarTs: lastBar.ts };
  patch.state = state;
  dirty = true;

  if (instance.status === "armed") {
    const peerSeries: Candle[][] = [];
    for (const peerInstId of params.peerInstIds) {
      const peerSymbol = peerInstId.split("-")[0]!;
      const series = await deps.store.confirmedCandles(peerSymbol, "5m", trendBarsNeeded(params));
      peerSeries.push(series.filter((bar) => bar.ts <= lastBar.ts));
    }
    const trigger = evaluateTrendTrigger(bars, peerSeries, params, instance.direction);
    if (!trigger.fired || trigger.atr === null || trigger.baseLevel === null || trigger.close === null || trigger.barTs === null) {
      const key = trigger.failedChecks.join(",");
      if (key !== state.lastChecksKey) {
        emit("watching", {
          failedChecks: trigger.failedChecks,
          atr: trigger.atr,
          close: trigger.close,
          checks: {
            atr: trigger.checks.atrExpansion.atr,
            atrPriorMax: trigger.checks.atrExpansion.priorMax,
            atrWindowMean: trigger.checks.atrExpansion.windowMean,
            tr: trigger.checks.triggerBar.tr,
            clv: trigger.checks.triggerBar.clv,
            breakoutLevel: trigger.checks.breakout.level,
            volume: trigger.checks.volume.volume,
            volumeMeanPrior: trigger.checks.volume.meanPrior,
            peers: trigger.checks.peers.count,
            er: trigger.checks.regime.er,
          },
        });
        state = { ...state, lastChecksKey: key };
        patch.state = state;
      }
      notes.push(`watching failed=${key}`);
      return conclude();
    }

    emit("trigger_fired", {
      barTs: trigger.barTs,
      close: trigger.close,
      atr: trigger.atr,
      baseLevel: trigger.baseLevel,
      failedChecks: [],
    });

    const spec = await deps.exchange.instrumentSpec(instance.instId);
    const stopPx = roundToStep(trendInitialStop(instance.direction, trigger.baseLevel, trigger.atr, params), spec.tickSz);
    const stopBeyond = instance.direction === "long" ? stopPx < trigger.close : stopPx > trigger.close;
    if (!(stopPx > 0) || !stopBeyond) {
      emit("open_skipped", { reason: "stop_not_beyond_close", stopPx, close: trigger.close });
      notes.push(`open_skipped:stop_not_beyond_close:${stopPx}`);
      return conclude();
    }
    const riskSized = computeTrendSize(instance.themeStopCapU, trigger.close, stopPx, spec.ctVal, spec.lotSz, spec.minSz);
    const firstLots = Math.floor(Number(instance.firstSz) / spec.lotSz + 1e-9) * spec.lotSz;
    const effSz = riskSized === null ? 0 : Math.min(Number(riskSized), firstLots);
    if (!(effSz > 0) || effSz < spec.minSz) {
      emit("open_skipped", { reason: "size_below_min", riskSized, firstSz: instance.firstSz });
      notes.push("open_skipped:size_below_min");
      return conclude();
    }
    const sz = formatToStep(effSz, spec.lotSz);

    if (shadow) {
      state = {
        ...state,
        entryPx: trigger.close,
        entryBarTs: trigger.barTs,
        entryAtr: trigger.atr,
        peakAtr: trigger.atr,
        stopPx,
        positionSz: effSz,
        adds: 0,
        lastAddAnchorPx: trigger.close,
        lastAddBarTs: null,
        exitReason: null,
      };
      patch.state = state;
      patch.status = "active";
      action = "opened";
      emit("shadow_open", { sz, entryPx: trigger.close, stopPx, atr: trigger.atr });
      notes.push(`shadow_open sz=${sz} px=${trigger.close} stop=${stopPx}`);
      return conclude();
    }

    const claimed = await deps.store.claim(instance.id, ACTION_LEASE_SEC);
    if (!claimed) {
      notes.push("open_claimed_elsewhere");
      return conclude();
    }
    const liveRow = await deps.store.getInstance(instance.id);
    if (!liveRow || liveRow.status !== "armed") {
      notes.push("open_aborted:instance_no_longer_armed");
      return conclude();
    }

    const outcome = await deps.submitter.submit(
      openIntent({
        intentId: ctx.newIntentId(),
        idempotencyKey: managementKey(["trend-open", instance.id, trigger.barTs!]),
        createdAt: new Date(nowMs).toISOString(),
        source: SOURCE,
        instId: instance.instId,
        direction: instance.direction,
        posSide: instance.posSide,
        tdMode: instance.tdMode,
        lever: instance.lever,
        sz,
        slTriggerPx: formatToStep(stopPx, spec.tickSz),
        tpTriggerPx: null,
        theme: instance.theme,
        themeStopCapU: instance.themeStopCapU,
        reason: `trend_follow open bar=${new Date(trigger.barTs).toISOString()} close=${trigger.close} atr=${round4(trigger.atr)} base=${trigger.baseLevel}`,
        ttlSec: INTENT_TTL_SEC,
      }),
    );

    if (outcome.status !== "acked") {
      const placed = !isNothingPlaced(outcome);
      emit("open_failed", { outcome: describeOutcome(outcome), placed });
      await alert("trend_open_failed", { outcome: describeOutcome(outcome), close: trigger.close });
      patch.status = "failed";
      action = "failed";
      notes.push(placed ? `open_unknown_outcome:${describeOutcome(outcome)}:check_okx` : `open_rejected:${describeOutcome(outcome)}`);
      return conclude();
    }

    const account = await deps.exchange.accountState(instance.instId);
    const position = findPosition(account, instance);
    if (!position) {
      emit("open_unverified", { ordId: outcome.ordId });
      await alert("trend_open_failed", { outcome: "acked_but_no_position", ordId: outcome.ordId });
      patch.status = "failed";
      action = "failed";
      notes.push("open_acked_but_no_position:check_okx");
      return conclude();
    }
    const converge = await convergeProtection(instance, ctx, events, Math.abs(position.pos), stopPx, spec);
    notes.push(...converge.notes);
    state = {
      ...state,
      entryPx: position.avgPx,
      entryBarTs: trigger.barTs,
      entryAtr: trigger.atr,
      peakAtr: trigger.atr,
      stopPx,
      positionSz: Math.abs(position.pos),
      adds: 0,
      lastAddAnchorPx: position.avgPx,
      lastAddBarTs: null,
      exitReason: null,
    };
    patch.state = state;
    patch.status = "active";
    action = "opened";
    emit("opened", { ordId: outcome.ordId, sz, avgPx: position.avgPx, stopPx, protectionConverged: converge.converged });
    await alert("trend_opened", { ord_id: outcome.ordId, sz, avg_px: position.avgPx, stop_px: stopPx });
    if (!converge.converged) {
      await alert("trend_reconcile_failed", { stage: "open", stop_px: stopPx });
    }
    notes.push(`opened sz=${sz} avg=${position.avgPx} stop=${stopPx}`);
    return conclude();
  }

  // status === "active"
  if (!shadow) {
    const account = await deps.exchange.accountState(instance.instId);
    const position = findPosition(account, instance);
    if (!position) {
      // The exchange stop (or a manual close) ended the position between bars.
      const plan = planAlgoReconcile(
        { size: 0, stopPx: state.stopPx ?? 0, lotSz: 1, tickSz: 1 },
        account.algos,
        instance.direction,
        instance.posSide,
      );
      for (const planned of plan) {
        if (planned.kind === "cancel_algos") {
          await deps.exchange
            .cancelAlgos(planned.algoIds.map((algoId) => ({ algoId, instId: instance.instId })))
            .catch((error: unknown) => notes.push(`orphan_cancel_failed:${describeError(error)}`));
          emit("orphan_algos_cancelled", { algoIds: planned.algoIds });
        }
      }
      const lastKnownSz = state.positionSz;
      state = { ...state, positionSz: 0, exitReason: state.exitReason ?? "position_gone" };
      patch.state = state;
      patch.status = "done";
      action = "done";
      emit("position_gone", { lastKnownSz });
      notes.push("position_gone");
      return conclude();
    }
    state = { ...state, entryPx: position.avgPx, positionSz: Math.abs(position.pos) };
    patch.state = state;
  }

  const exitDecision = evaluateTrendExit(bars, state, params, instance.direction);
  state = { ...state, peakAtr: exitDecision.peakAtr ?? state.peakAtr };
  patch.state = state;

  if (exitDecision.exit && exitDecision.reason !== null) {
    emit("exit_triggered", {
      reason: exitDecision.reason,
      atr: exitDecision.atr,
      peakAtr: exitDecision.peakAtr,
      ma: exitDecision.ma,
      close: exitDecision.close,
    });
    const closed = await closeOut(instance, ctx, {
      shadow,
      state,
      lastBar,
      reason: exitDecision.reason,
      events,
      notes,
      alert,
    });
    if (closed) {
      state = closed;
      patch.state = state;
      patch.status = "done";
      action = "exited";
    } else {
      notes.push("close_not_completed:stays_active");
    }
    return conclude();
  }

  const spec = await deps.exchange.instrumentSpec(instance.instId);
  if (exitDecision.atr !== null && state.stopPx !== null) {
    const plan = planTrendAdd(state, {
      direction: instance.direction,
      params,
      bar: lastBar,
      atr: exitDecision.atr,
      ctVal: spec.ctVal,
      lotSz: spec.lotSz,
      minSz: spec.minSz,
      firstSz: Number(instance.firstSz),
      themeStopCapU: instance.themeStopCapU,
    });
    if (plan.add) {
      emit("add_planned", {
        sz: plan.sz,
        newStopPx: plan.newStopPx,
        worstCaseLossU: round4(plan.worstCaseLossU),
        excursion: round4(plan.excursion),
      });
      if (shadow) {
        const total = state.positionSz + plan.szNum;
        const blended = (state.entryPx! * state.positionSz + lastBar.close * plan.szNum) / total;
        state = {
          ...state,
          entryPx: blended,
          positionSz: total,
          adds: state.adds + 1,
          lastAddAnchorPx: lastBar.close,
          lastAddBarTs: lastBar.ts,
          stopPx: plan.newStopPx,
        };
        patch.state = state;
        action = "added";
        emit("shadow_add", { sz: plan.sz, newStopPx: plan.newStopPx, adds: state.adds });
        notes.push(`shadow_add sz=${plan.sz} stop=${plan.newStopPx}`);
        return conclude();
      }

      const claimed = await deps.store.claim(instance.id, ACTION_LEASE_SEC);
      if (!claimed) {
        notes.push("add_claimed_elsewhere");
        return conclude();
      }
      const liveRow = await deps.store.getInstance(instance.id);
      if (!liveRow || liveRow.status !== "active") {
        notes.push("add_aborted:instance_no_longer_active");
        return conclude();
      }
      const newStopPx = roundToStep(plan.newStopPx, spec.tickSz);
      const outcome = await deps.submitter.submit(
        openIntent({
          intentId: ctx.newIntentId(),
          idempotencyKey: managementKey(["trend-add", instance.id, state.adds, lastBar.ts]),
          createdAt: new Date(nowMs).toISOString(),
          source: SOURCE,
          instId: instance.instId,
          direction: instance.direction,
          posSide: instance.posSide,
          tdMode: instance.tdMode,
          lever: instance.lever,
          sz: plan.sz,
          slTriggerPx: formatToStep(newStopPx, spec.tickSz),
          tpTriggerPx: null,
          theme: instance.theme,
          themeStopCapU: instance.themeStopCapU,
          reason: `trend_follow add n=${state.adds + 1} bar=${new Date(lastBar.ts).toISOString()} close=${lastBar.close}`,
          ttlSec: INTENT_TTL_SEC,
        }),
      );
      if (outcome.status !== "acked") {
        emit("add_failed", { outcome: describeOutcome(outcome), placed: !isNothingPlaced(outcome) });
        if (!isNothingPlaced(outcome)) {
          await alert("trend_add_failed", { outcome: describeOutcome(outcome) });
        }
        notes.push(`add_not_completed:${describeOutcome(outcome)}`);
        return conclude();
      }
      const account = await deps.exchange.accountState(instance.instId);
      const position = findPosition(account, instance);
      if (!position) {
        emit("add_unverified", { ordId: outcome.ordId });
        await alert("trend_add_failed", { outcome: "acked_but_no_position", ordId: outcome.ordId });
        notes.push("add_acked_but_no_position:check_okx");
        return conclude();
      }
      const converge = await convergeProtection(instance, ctx, events, Math.abs(position.pos), newStopPx, spec);
      notes.push(...converge.notes);
      state = {
        ...state,
        entryPx: position.avgPx,
        positionSz: Math.abs(position.pos),
        adds: state.adds + 1,
        lastAddAnchorPx: lastBar.close,
        lastAddBarTs: lastBar.ts,
        stopPx: newStopPx,
      };
      patch.state = state;
      action = "added";
      emit("added", { ordId: outcome.ordId, sz: plan.sz, newStopPx, adds: state.adds, protectionConverged: converge.converged });
      await alert("trend_added", { ord_id: outcome.ordId, sz: plan.sz, stop_px: newStopPx, adds: state.adds });
      if (!converge.converged) await alert("trend_reconcile_failed", { stage: "add", stop_px: newStopPx });
      notes.push(`added sz=${plan.sz} stop=${newStopPx}`);
      return conclude();
    }
    if (plan.reason === "risk_cap") {
      emit("add_skipped_risk", { reason: plan.reason });
      notes.push("add_skipped:risk_cap");
    }
  }

  if (!shadow && state.stopPx !== null && state.positionSz > 0) {
    const account = await deps.exchange.accountState(instance.instId);
    const plan = planAlgoReconcile(
      { size: state.positionSz, stopPx: state.stopPx, lotSz: spec.lotSz, tickSz: spec.tickSz },
      account.algos,
      instance.direction,
      instance.posSide,
    );
    if (plan.length > 0) {
      const claimed = await deps.store.claim(instance.id, ACTION_LEASE_SEC);
      if (claimed) {
        const converge = await convergeProtection(instance, ctx, events, state.positionSz, state.stopPx, spec);
        notes.push(...converge.notes);
        if (!converge.converged) await alert("trend_reconcile_failed", { stage: "drift", stop_px: state.stopPx });
      } else {
        notes.push("reconcile_claimed_elsewhere");
      }
    }
  }

  emit("active_snapshot", {
    close: lastBar.close,
    atr: exitDecision.atr,
    peakAtr: state.peakAtr,
    ma: exitDecision.ma,
    positionSz: state.positionSz,
    stopPx: state.stopPx,
    adds: state.adds,
  });
  notes.push(`active sz=${state.positionSz} stop=${state.stopPx ?? "-"} adds=${state.adds}`);
  return conclude();
}

interface CloseOutArgs {
  shadow: boolean;
  state: TrendRuntimeState;
  lastBar: Candle;
  reason: string;
  events: TrendEventInsert[];
  notes: string[];
  alert: (kind: string, payload: Record<string, unknown>) => Promise<void>;
}

/**
 * Closes the position and returns the terminal state, or null when a live close could not be
 * completed (the instance then stays active and retries on the next bar). Shadow closes are
 * simulated at the last close. A completed live close also sweeps orphan protective algos.
 */
async function closeOut(
  instance: TrendInstanceRow,
  ctx: RunContext,
  args: CloseOutArgs,
): Promise<TrendRuntimeState | null> {
  const { deps, nowMs } = ctx;
  const { state, lastBar, reason, events, notes, alert } = args;
  if (args.shadow) {
    events.push({
      instanceId: instance.id,
      kind: "shadow_exit",
      detail: { reason, close: lastBar.close, sz: state.positionSz },
    });
    notes.push(`shadow_exit reason=${reason}`);
    return { ...state, positionSz: 0, exitReason: reason };
  }

  const spec = await deps.exchange.instrumentSpec(instance.instId);
  const account = await deps.exchange.accountState(instance.instId);
  const position = findPosition(account, instance);
  if (!position) {
    events.push({ instanceId: instance.id, kind: "position_gone", detail: { during: reason } });
    return { ...state, positionSz: 0, exitReason: reason };
  }

  const claimed = await deps.store.claim(instance.id, ACTION_LEASE_SEC);
  if (!claimed) {
    notes.push("close_claimed_elsewhere");
    return null;
  }
  const liveRow = await deps.store.getInstance(instance.id);
  if (!liveRow || liveRow.status !== "active") {
    notes.push("close_aborted:instance_no_longer_active");
    return null;
  }

  const sz = formatToStep(Math.abs(position.pos), spec.lotSz);
  const outcome = await deps.submitter.submit(
    closeIntent({
      intentId: ctx.newIntentId(),
      idempotencyKey: managementKey(["trend-close", instance.id, lastBar.ts, reason]),
      createdAt: new Date(nowMs).toISOString(),
      source: SOURCE,
      instId: instance.instId,
      direction: instance.direction,
      posSide: instance.posSide,
      tdMode: instance.tdMode,
      sz,
      reason: `trend_follow exit reason=${reason} bar=${new Date(lastBar.ts).toISOString()}`,
      ttlSec: INTENT_TTL_SEC,
    }),
  );
  if (outcome.status !== "acked") {
    events.push({
      instanceId: instance.id,
      kind: "close_failed",
      detail: { outcome: describeOutcome(outcome), placed: !isNothingPlaced(outcome), reason },
    });
    if (!isNothingPlaced(outcome)) {
      await alert("trend_close_failed", { outcome: describeOutcome(outcome), reason });
    }
    notes.push(`close_failed:${describeOutcome(outcome)}`);
    return null;
  }

  const after = await deps.exchange.accountState(instance.instId);
  const remaining = findPosition(after, instance);
  if (remaining) {
    events.push({ instanceId: instance.id, kind: "close_unverified", detail: { ordId: outcome.ordId } });
    await alert("trend_close_failed", { outcome: "acked_but_position_remains", ordId: outcome.ordId });
    notes.push("close_acked_but_position_remains:check_okx");
    return null;
  }
  const orphans = protectiveAlgos(after.algos, instance.direction, instance.posSide);
  if (orphans.length > 0) {
    await deps.exchange
      .cancelAlgos(orphans.map((algo) => ({ algoId: algo.algoId, instId: instance.instId })))
      .catch((error: unknown) => notes.push(`orphan_cancel_failed:${describeError(error)}`));
    events.push({
      instanceId: instance.id,
      kind: "orphan_algos_cancelled",
      detail: { algoIds: orphans.map((algo) => algo.algoId) },
    });
  }
  events.push({ instanceId: instance.id, kind: "closed", detail: { reason, ordId: outcome.ordId, sz } });
  await alert("trend_exited", { reason, ord_id: outcome.ordId, sz });
  notes.push(`closed reason=${reason} sz=${sz}`);
  return { ...state, positionSz: 0, exitReason: reason };
}

/**
 * Cron entry point (EDGE_CRON_SECRET). Every armed/active instance for the mode is evaluated in
 * isolation. With no live instances this is one indexed query and an immediate exit, so the cron
 * stays cheap against the project's Disk IO budget.
 */
export function createTrendEvaluatorHandler(deps: TrendEvaluatorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[trend-evaluator] ${message}`));
  const newIntentId = deps.newIntentId ?? (() => `tf-${crypto.randomUUID()}`);

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
    let instances: TrendInstanceRow[];
    try {
      engaged = await deps.store.killSwitchEngaged();
      instances = engaged ? [] : await deps.store.listActiveInstances(deps.mode);
    } catch (error) {
      const message = `trend instance read failed: ${describeError(error)}`;
      log(message);
      return json(500, { error: message });
    }
    if (engaged) return json(200, { status: "skipped", reason: "kill_switch_engaged", mode: deps.mode });

    const reports: InstanceReport[] = [];
    for (const instance of instances) {
      const ctx: RunContext = { deps, nowMs: now(), newIntentId, log };
      try {
        reports.push(await evaluateInstance(instance, ctx));
      } catch (error) {
        const note = `error:${describeError(error)}`;
        log(`instance=${instance.id} inst=${instance.instId} ${note}`);
        reports.push({ id: instance.id, instId: instance.instId, action: "none", notes: [note] });
        if (!deps.dryRun) {
          await deps.store
            .recordEval(instance.id, { lastEvalAt: new Date(ctx.nowMs).toISOString(), lastNote: note })
            .catch((recordError: unknown) => log(`instance=${instance.id} eval record failed: ${describeError(recordError)}`));
        }
      }
    }

    return json(200, {
      status: "ok",
      mode: deps.mode,
      dryRun: deps.dryRun,
      instances: instances.length,
      reports,
      durationMs: now() - started,
    });
  };
}
