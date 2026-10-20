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
  roundTrendStop,
  TREND_BAR_MS,
  trendBarsNeeded,
  trendInitialStop,
  type TrendDirection,
  type TrendAlgoView,
  type TrendParams,
  type TrendRuntimeState,
} from "./core/trend.ts";
import type { Candle } from "./core/types.ts";

export const SOURCE = "hive:trend-evaluator";
export const INTENT_TTL_SEC = 120;
export const ACTION_LEASE_SEC = 300;
/** How long an accepted add may wait for its fill to appear on the account before it is given up. */
export const PENDING_ADD_TIMEOUT_MS = 12 * 5 * 60_000;
/** A series is stale when its newest confirmed bar is older than this many of its own intervals. */
const MAX_BAR_AGE_INTERVALS = 3;
/** Rejections that happened before OKX took any request. Anything else may have reached OKX and is treated as unknown. */
const NOTHING_PLACED_STATUSES = new Set(["rejected_risk", "rejected_auth", "rejected_invalid", "expired"]);
const NOTHING_PLACED_REASON = /^okx_rejected:|^store_unavailable$/;

export type TrendAction =
  | "none"
  | "opened"
  | "added"
  | "add_pending"
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
 * Any position row on the instance's side, whatever its direction. The account aggregates every
 * same-instrument exposure into that one row, so any non-zero value — a manual position, another
 * strategy's — is exposure this instance does not own.
 */
function findSidePosition(account: AccountState, instance: TrendInstanceRow): PositionRow | null {
  const row = account.positions.find((candidate) =>
    instance.posSide === "net" ? candidate.posSide === "net" : candidate.posSide === instance.posSide,
  );
  if (!row || row.pos === 0 || !Number.isFinite(row.pos)) return null;
  return row;
}

/**
 * Converges the exchange's protective algos to (totalSize at stopPx) after an action. The plan comes
 * from core; execution is: one amend_tpsl through order-submit (which replaces the instrument's
 * recorded algos), then a direct cancel of the replaced own algo if the amend did not remove it
 * (the position-manager precedent), then a fresh read whose plan must be empty.
 *
 * ownedAlgoId is the newest protective algo id this instance placed (null before the first
 * converge). Only a leftover carrying that id is ever cancelled: any other protective algo may
 * be guarding external exposure added after this instance opened, and deleting it would leave
 * that exposure unprotected. Such algos are reported in externalAlgoIds and excluded from
 * planning so they neither trigger amend churn nor get swept.
 */
async function convergeProtection(
  instance: TrendInstanceRow,
  ctx: RunContext,
  events: TrendEventInsert[],
  totalSize: number,
  stopPx: number,
  spec: InstrumentSpec,
  ownedAlgoId: string | null,
): Promise<{ converged: boolean; notes: string[]; algoId: string | null; externalAlgoIds: string[] }> {
  const { deps } = ctx;
  const notes: string[] = [];
  const desired = { size: totalSize, stopPx, lotSz: spec.lotSz, tickSz: spec.tickSz };
  const knownIds = new Set<string>();
  if (ownedAlgoId) knownIds.add(ownedAlgoId);
  // Unknown protective algos are excludable only once this instance tracks an algo id. Before
  // the first converge we cannot tell ours from someone else's, so planning stays conservative
  // (as before) and the sweep cancels nothing: deleting an unattributable algo could remove
  // external protection, while the amend itself already replaces everything recorded.
  const canDistinguish = ownedAlgoId !== null;
  const externalIds = (algos: readonly TrendAlgoView[]): string[] =>
    canDistinguish
      ? protectiveAlgos(algos, instance.direction, instance.posSide)
          .filter((algo) => !knownIds.has(algo.algoId))
          .map((algo) => algo.algoId)
      : [];
  let account = await deps.exchange.accountState(instance.instId);
  const ignoredNow = externalIds(account.algos);
  if (ignoredNow.length > 0) notes.push(`external_algos_ignored:${ignoredNow.join(",")}`);
  let plan = planAlgoReconcile(desired, account.algos, instance.direction, instance.posSide, ignoredNow);
  let newAlgoId: string | null = null;
  if (plan.length === 0) return { converged: true, notes, algoId: newAlgoId, externalAlgoIds: ignoredNow };

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
        return { converged: false, notes, algoId: newAlgoId, externalAlgoIds: externalIds(account.algos) };
      }
      newAlgoId = outcome.algoId;
      knownIds.add(newAlgoId);
      notes.push(`reconcile_amend:${outcome.algoId}`);
      // The amend replaces algos recorded in the orders table. A leftover carrying the replaced
      // own algo id is cancelled directly (the position-manager precedent); anything else
      // protective is left alone — it may belong to external exposure.
      const after = await deps.exchange.accountState(instance.instId);
      const leftovers = protectiveAlgos(after.algos, instance.direction, instance.posSide).filter(
        (algo) => algo.algoId !== outcome.algoId,
      );
      const ownedLeftovers = leftovers.filter((algo) => algo.algoId === ownedAlgoId);
      const otherLeftovers = leftovers.filter((algo) => algo.algoId !== ownedAlgoId);
      if (ownedLeftovers.length > 0) {
        await deps.exchange.cancelAlgos(ownedLeftovers.map((algo) => ({ algoId: algo.algoId, instId: instance.instId })));
        notes.push(`cancelled_leftovers:${ownedLeftovers.map((algo) => algo.algoId).join(",")}`);
      }
      if (otherLeftovers.length > 0) {
        notes.push(
          `${canDistinguish ? "external" : "untracked"}_algos_preserved:${otherLeftovers.map((algo) => algo.algoId).join(",")}`,
        );
      }
    }
  }

  account = await deps.exchange.accountState(instance.instId);
  plan = planAlgoReconcile(desired, account.algos, instance.direction, instance.posSide, externalIds(account.algos));
  const converged = plan.length === 0;
  events.push({
    instanceId: instance.id,
    kind: converged ? "reconciled" : "reconcile_failed",
    detail: { desiredSize: totalSize, desiredStop: stopPx, remainingPlan: plan },
  });
  if (!converged) notes.push("reconcile_incomplete");
  return { converged, notes, algoId: newAlgoId, externalAlgoIds: externalIds(account.algos) };
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
  const alert = async (kind: string, payload: Record<string, unknown>, occurrence?: string): Promise<void> => {
    if (deps.dryRun) return;
    await deps.store
      .insertAlert({
        // Kinds that can happen more than once per instance (adds, close/reconcile failures)
        // pass an occurrence discriminator: with a per-kind key alone, insertAlert's
        // ignore-duplicates would fan out only the first occurrence and swallow the rest.
        dedup_key: `trend:${instance.id}:${kind}${occurrence ? `:${occurrence}` : ""}`,
        rule_id: null,
        symbol: instance.symbol,
        kind,
        severity: "critical",
        payload: { source: SOURCE, instance_id: instance.id, inst_id: instance.instId, ...payload },
      })
      .catch((error: unknown) => ctx.log(`instance=${instance.id} alert insert failed: ${describeError(error)}`));
  };

  /**
   * Settles a pending add against the account: commits its fill (size, blended entry,
   * unified stop) once the filled size is visible. Returns "settled" when the book now
   * includes the add, "waiting" while the fill is not visible yet, and "timeout_cleared"
   * when the add is presumed dead and dropped. Terminal paths (exit, expiry) call this
   * BEFORE closing out, so a just-filled add is never left out of the closing size.
   */
  const settlePendingAdd = async (
    nowBarTs: number,
    spec: InstrumentSpec,
  ): Promise<"settled" | "waiting" | "timeout_cleared"> => {
    const pending = state.pendingAdd!;
    const expected = state.positionSz + pending.szNum;
    const fillTol = spec.lotSz / 2;
    const pendingAccount = await deps.exchange.accountState(instance.instId);
    const pendingPosition = findPosition(pendingAccount, instance);
    const observed = pendingPosition ? Math.abs(pendingPosition.pos) : 0;
    if (!pendingPosition || observed < expected - fillTol) {
      if (nowBarTs - pending.barTs > PENDING_ADD_TIMEOUT_MS) {
        // Market-order fills land within seconds; after this long the add is presumed dead.
        // The order may still fill later — then the own-size cap treats it as external size.
        state = { ...state, pendingAdd: null };
        patch.state = state;
        dirty = true;
        notes.push("add_fill_timeout:pending_cleared");
        await alert("trend_add_failed", { outcome: "add_fill_timeout" }, `${pending.barTs}:${state.adds}`);
        return "timeout_cleared";
      }
      action = "add_pending";
      emit("add_fill_pending", { expected, observed });
      notes.push(`add_fill_pending:expected=${expected}`);
      return "waiting";
    }
    const ownTotal = Math.min(observed, expected);
    const converge = await convergeProtection(
      instance,
      ctx,
      events,
      ownTotal,
      pending.newStopPx,
      spec,
      state.protectiveAlgoId,
    );
    notes.push(...converge.notes);
    state = {
      ...state,
      entryPx:
        ownTotal === observed
          ? pendingPosition.avgPx
          : (state.entryPx! * state.positionSz + pending.anchorPx * pending.szNum) / ownTotal,
      positionSz: ownTotal,
      protectiveAlgoId: converge.algoId ?? state.protectiveAlgoId,
      pendingAdd: null,
      adds: state.adds + 1,
      lastAddAnchorPx: pending.anchorPx,
      lastAddBarTs: pending.barTs,
      stopPx: pending.newStopPx,
    };
    patch.state = state;
    if (converge.externalAlgoIds.length > 0) {
      await alert(
        "trend_external_algos",
        { algo_ids: converge.externalAlgoIds },
        `algos:${[...converge.externalAlgoIds].sort().join(",")}`,
      );
    }
    action = "added";
    emit("added", {
      ordId: "pending_settled",
      sz: String(pending.szNum),
      newStopPx: pending.newStopPx,
      adds: state.adds,
      protectionConverged: converge.converged,
    });
    await alert(
      "trend_added",
      { ord_id: "pending_settled", sz: String(pending.szNum), stop_px: pending.newStopPx, adds: state.adds },
      `${pending.barTs}:${state.adds}`,
    );
    if (!converge.converged)
      await alert("trend_reconcile_failed", { stage: "add", stop_px: pending.newStopPx }, `add:${pending.barTs}:${state.adds}`);
    notes.push(`added sz=${pending.szNum} stop=${pending.newStopPx} (fill settled)`);
    return "settled";
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

  // Expiry is processed before the staleness gate. Closing a live position reads the account, not
  // the tape, so a candle-collection outage must not strand an active instance past its expiry
  // (or leave an armed one un-expired) until fresh bars resume. With no bar at all, a synthetic
  // one — stamped at the expiry so retry idempotency keys stay stable, priced at the entry for
  // the shadow simulation — stands in for the close bookkeeping.
  if (nowMs > instance.expiresAtMs) {
    const closeBar: Candle =
      lastBar ??
      (() => {
        const px = state.entryPx ?? 0;
        return { ts: instance.expiresAtMs, open: px, high: px, low: px, close: px, volume: 0, volCcy: 0, confirmed: true };
      })();
    if (instance.status === "active" && (shadow ? state.positionSz > 0 : true)) {
      if (!shadow && state.pendingAdd) {
        // Settle a pending add before the terminal close, so a just-filled add is included
        // in the closing size instead of being left open after the instance expires.
        const pendingBarTs = state.pendingAdd.barTs;
        const spec = await deps.exchange.instrumentSpec(instance.instId);
        const settled = await settlePendingAdd(closeBar.ts, spec);
        if (settled === "waiting") {
          // Expiry cannot wait for the fill: drop the marker and close what is on the book.
          state = { ...state, pendingAdd: null };
          patch.state = state;
          dirty = true;
          notes.push("expiry_cleared_pending_add");
          await alert("trend_add_failed", { outcome: "expiry_cleared_pending_add" }, `${pendingBarTs}:${state.adds}`);
        }
      }
      const closed = await closeOut(instance, ctx, {
        shadow,
        state,
        lastBar: closeBar,
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
      // Lost the action claim: another invocation owns this cycle. Persisting our pre-open
      // snapshot via conclude() could land after the winner persisted the opened state and
      // clobber it, so the loser returns without any state write.
      notes.push("open_claimed_elsewhere");
      return { id: instance.id, instId: instance.instId, action, notes };
    }
    const liveRow = await deps.store.getInstance(instance.id);
    if (!liveRow || liveRow.status !== "armed") {
      notes.push("open_aborted:instance_no_longer_armed");
      return conclude();
    }

    // Collision prevention: this state machine accounts for exactly one owner per instrument
    // side, but the account aggregates every same-instrument exposure into one row. If anything
    // already sits on this side — a manual position, another strategy — opening would adopt that
    // size into this instance's book (and a later exit would close it). Refuse and stay armed.
    const preOpen = await deps.exchange.accountState(instance.instId);
    const existing = findSidePosition(preOpen, instance);
    if (existing) {
      emit("open_skipped", { reason: "position_collision", observedPos: existing.pos, observedAvgPx: existing.avgPx });
      await alert("trend_open_blocked", { reason: "position_collision", observed_pos: existing.pos });
      notes.push(`open_skipped:position_collision:${existing.pos}`);
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

    // The provisional active state is recorded BEFORE any fallible step: if the order was
    // possibly placed (acked, or an unknown outcome), the row is already active when
    // conclude() persists it, so the next cycle adopts the position from the account instead
    // of the collision guard refusing it forever. Entry price/size/anchor are provisional
    // (the trigger close and the submitted size) until verification confirms them;
    // openVerified gates add planning and stop drift-reconcile until then.
    const provisional = {
      ...state,
      entryPx: trigger.close,
      entryBarTs: trigger.barTs,
      entryAtr: trigger.atr,
      peakAtr: trigger.atr,
      stopPx,
      positionSz: Number(sz),
      protectiveAlgoId: null,
      pendingAdd: null,
      openVerified: false,
      adds: 0,
      lastAddAnchorPx: trigger.close,
      lastAddBarTs: null,
      exitReason: null,
    };

    if (outcome.status !== "acked") {
      const placed = !isNothingPlaced(outcome);
      emit("open_failed", { outcome: describeOutcome(outcome), placed });
      await alert("trend_open_failed", { outcome: describeOutcome(outcome), close: trigger.close });
      if (placed) {
        // Possibly placed despite the lost response: stay recoverable and adopt the position
        // from the account on the next cycle. The open is never resubmitted, so no
        // double-fill risk; the deterministic idempotency key stays unused.
        state = provisional;
        patch.state = state;
        patch.status = "active";
        action = "opened";
        emit("open_unknown_outcome", { outcome: describeOutcome(outcome) });
        notes.push(`open_unknown_outcome:${describeOutcome(outcome)}:verify_next_cycle`);
      } else {
        patch.status = "failed";
        action = "failed";
        notes.push(`open_rejected:${describeOutcome(outcome)}`);
      }
      return conclude();
    }

    state = provisional;
    patch.state = state;
    patch.status = "active";
    action = "opened";
    emit("opened_ack", { ordId: outcome.ordId, sz, stopPx });

    try {
      const account = await deps.exchange.accountState(instance.instId);
      const position = findPosition(account, instance);
      if (!position) {
        // Acked but the fill is not visible yet: NOT terminal. The provisional active state
        // above stands, so the next cycle adopts the fill; if it never appears, the active
        // branch closes the book as position_gone.
        emit("open_unverified", { ordId: outcome.ordId });
        await alert("trend_open_failed", { outcome: "acked_but_no_position", ordId: outcome.ordId });
        notes.push("open_acked_but_no_position:verify_next_cycle");
      } else {
        const converge = await convergeProtection(
          instance,
          ctx,
          events,
          Math.abs(position.pos),
          stopPx,
          spec,
          state.protectiveAlgoId,
        );
        notes.push(...converge.notes);
        state = {
          ...state,
          entryPx: position.avgPx,
          positionSz: Math.abs(position.pos),
          protectiveAlgoId: converge.algoId ?? state.protectiveAlgoId,
          openVerified: true,
          lastAddAnchorPx: position.avgPx,
        };
        patch.state = state;
        if (converge.externalAlgoIds.length > 0) {
          await alert(
            "trend_external_algos",
            { algo_ids: converge.externalAlgoIds },
            `algos:${[...converge.externalAlgoIds].sort().join(",")}`,
          );
        }
        emit("opened", {
          ordId: outcome.ordId,
          sz,
          avgPx: position.avgPx,
          stopPx,
          protectionConverged: converge.converged,
        });
        await alert("trend_opened", { ord_id: outcome.ordId, sz, avg_px: position.avgPx, stop_px: stopPx });
        if (!converge.converged) {
          await alert("trend_reconcile_failed", { stage: "open", stop_px: stopPx }, `open:${trigger.barTs}`);
        }
      }
    } catch (error) {
      // Already active (persisted by conclude below): the next cycle re-reads the account and
      // converges protection, so a throw here degrades to a retry rather than a wedged row.
      notes.push(`post_open_verify_threw:${describeError(error)}`);
      events.push({
        instanceId: instance.id,
        kind: "reconcile_failed",
        detail: { stage: "open", error: describeError(error) },
      });
      await alert("trend_reconcile_failed", { stage: "open_verify_threw" }, `open:${trigger.barTs}`);
    }
    notes.push(`opened sz=${sz} avg=${state.entryPx} stop=${stopPx}`);
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
      const neverFilled = !state.openVerified;
      state = {
        ...state,
        positionSz: 0,
        exitReason: state.exitReason ?? (neverFilled ? "open_never_filled" : "position_gone"),
      };
      patch.state = state;
      patch.status = "done";
      action = "done";
      emit("position_gone", { lastKnownSz });
      notes.push(neverFilled ? "open_never_filled" : "position_gone");
      return conclude();
    }
    // Track only this instance's own size: the account row aggregates any same-instrument
    // exposure, so an outside add must not be adopted into this book (a later exit would close
    // it), and the account's blended average must not replace this instance's entry price while
    // the sizes disagree.
    //
    // Ownership is judged from this instance's own algo lifecycle, not from the aggregate
    // size alone: once our protective algo is gone, either our unified stop fired — our
    // tracked size is closed, so anything left on the row is external exposure — or the
    // algo was cancelled, in which case re-arming protection the user removed is not ours
    // to do either. Both ways the book no longer owns this row, whatever size it shows
    // (an equal or larger remainder after the stop fired is external top-up, not ours).
    // A shrink with our algo still in place was a manual reduction; the remainder is ours.
    const observedSz = Math.abs(position.pos);
    const prevOwn = state.positionSz;
    let ownSz: number;
    let ownershipLost = false;
    const ourAlgoGone =
      state.protectiveAlgoId !== null && !account.algos.some((algo) => algo.algoId === state.protectiveAlgoId);
    if (prevOwn > 0 && ourAlgoGone) {
      ownSz = 0;
      ownershipLost = true;
    } else if (prevOwn > 0 && observedSz < prevOwn) {
      ownSz = observedSz;
    } else {
      ownSz = prevOwn > 0 ? Math.min(prevOwn, observedSz) : observedSz;
    }
    const justVerified = !state.openVerified;
    state = {
      ...state,
      positionSz: ownSz,
      ...(ownSz === observedSz ? { entryPx: position.avgPx } : {}),
      ...(justVerified ? { openVerified: true, lastAddAnchorPx: position.avgPx } : {}),
    };
    patch.state = state;
    if (justVerified) emit("open_verified", { avgPx: position.avgPx, sz: ownSz });
    if (ownershipLost) {
      state = { ...state, exitReason: "ownership_lost" };
      patch.state = state;
      patch.status = "done";
      action = "done";
      emit("ownership_lost", { prevOwn, externalRemainder: observedSz });
      await alert("trend_ownership_lost", { prev_own: prevOwn, external_remainder: observedSz });
      notes.push(`ownership_lost:external_remainder=${observedSz}`);
      return conclude();
    }
  }

  const spec = await deps.exchange.instrumentSpec(instance.instId);
  // A pending add settles BEFORE the exit decision: if its fill landed, the exit's closing
  // size must include it — evaluating (or executing) the exit first would leave the
  // just-filled add open after the strategy is marked done.
  if (!shadow && state.pendingAdd) {
    const settled = await settlePendingAdd(lastBar.ts, spec);
    if (settled !== "settled") return conclude();
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

  // Add planning waits for the opening fill to be verified: with no confirmed position
  // there is nothing to pyramid.
  if (exitDecision.atr !== null && state.stopPx !== null && state.openVerified) {
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
        // Same rule as the open path: the claim loser must not persist its pre-add snapshot
        // over the winner's committed add state.
        notes.push("add_claimed_elsewhere");
        return { id: instance.id, instId: instance.instId, action, notes };
      }
      const liveRow = await deps.store.getInstance(instance.id);
      if (!liveRow || liveRow.status !== "active") {
        notes.push("add_aborted:instance_no_longer_active");
        return conclude();
      }
      // Directional, not nearest-tick: planTrendAdd verified the theme cap against the
      // unrounded stop, and rounding toward the position can only shrink the loss from there,
      // so the submitted stop never breaches the verified cap by a rounding half-tick.
      const newStopPx = roundTrendStop(instance.direction, plan.newStopPx, spec.tickSz);
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
        const placed = !isNothingPlaced(outcome);
        emit("add_failed", { outcome: describeOutcome(outcome), placed });
        if (placed) {
          await alert("trend_add_failed", { outcome: describeOutcome(outcome) }, `${lastBar.ts}:${state.adds}`);
          // Possibly placed despite the lost response (same rule as the open path): hang the
          // add as pending so the next cycle settles it from the account. Dropping it here
          // would cap a filled add back to the old tracked size as "external" exposure and
          // could plan a second add, leaving the first fill outside the tracked protection.
          // The add is never resubmitted.
          state = {
            ...state,
            pendingAdd: { szNum: plan.szNum, barTs: lastBar.ts, newStopPx, anchorPx: lastBar.close },
          };
          patch.state = state;
          action = "add_pending";
          emit("add_fill_pending", { outcome: describeOutcome(outcome), expected: state.positionSz + plan.szNum });
          notes.push(`add_unknown_outcome:${describeOutcome(outcome)}:settle_next_cycle`);
        } else {
          notes.push(`add_not_completed:${describeOutcome(outcome)}`);
        }
        return conclude();
      }
      const account = await deps.exchange.accountState(instance.instId);
      const position = findPosition(account, instance);
      if (!position) {
        emit("add_unverified", { ordId: outcome.ordId });
        await alert("trend_add_failed", { outcome: "acked_but_no_position", ordId: outcome.ordId }, `${lastBar.ts}:${state.adds}`);
        notes.push("add_acked_but_no_position:check_okx");
        return conclude();
      }
      // Only the size this instance owns goes on its book: its tracked size plus this add,
      // capped at what the account actually shows. Anything above that is someone else's.
      // The add is committed only once its fill is visible on the account: committing early
      // would advance the stop and the add count while the filled size stays outside the
      // unified protection. While pending, the next cycles settle it instead of re-submitting.
      const expected = state.positionSz + plan.szNum;
      const observed = Math.abs(position.pos);
      if (observed < expected - spec.lotSz / 2) {
        state = {
          ...state,
          pendingAdd: { szNum: plan.szNum, barTs: lastBar.ts, newStopPx, anchorPx: lastBar.close },
        };
        patch.state = state;
        action = "add_pending";
        emit("add_fill_pending", { ordId: outcome.ordId, expected });
        notes.push(`add_pending_fill:${outcome.ordId}`);
        return conclude();
      }
      const ownTotal = Math.min(observed, expected);
      const converge = await convergeProtection(instance, ctx, events, ownTotal, newStopPx, spec, state.protectiveAlgoId);
      notes.push(...converge.notes);
      state = {
        ...state,
        entryPx:
          ownTotal === observed
            ? position.avgPx
            : (state.entryPx! * state.positionSz + lastBar.close * plan.szNum) / ownTotal,
        positionSz: ownTotal,
        protectiveAlgoId: converge.algoId ?? state.protectiveAlgoId,
        adds: state.adds + 1,
        lastAddAnchorPx: lastBar.close,
        lastAddBarTs: lastBar.ts,
        stopPx: newStopPx,
      };
      patch.state = state;
      if (converge.externalAlgoIds.length > 0) {
        await alert(
          "trend_external_algos",
          { algo_ids: converge.externalAlgoIds },
          `algos:${[...converge.externalAlgoIds].sort().join(",")}`,
        );
      }
      action = "added";
      emit("added", { ordId: outcome.ordId, sz: plan.sz, newStopPx, adds: state.adds, protectionConverged: converge.converged });
      await alert("trend_added", { ord_id: outcome.ordId, sz: plan.sz, stop_px: newStopPx, adds: state.adds }, `${lastBar.ts}:${state.adds}`);
      if (!converge.converged) await alert("trend_reconcile_failed", { stage: "add", stop_px: newStopPx }, `add:${lastBar.ts}:${state.adds}`);
      notes.push(`added sz=${plan.sz} stop=${newStopPx}`);
      return conclude();
    }
    if (plan.reason === "risk_cap") {
      emit("add_skipped_risk", { reason: plan.reason });
      notes.push("add_skipped:risk_cap");
    }
  }

  // Stop drift-reconcile waits for the opening fill to be verified: with no confirmed
  // position there is no protection to converge yet.
  if (!shadow && state.stopPx !== null && state.positionSz > 0 && state.openVerified) {
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
        const converge = await convergeProtection(
          instance,
          ctx,
          events,
          state.positionSz,
          state.stopPx,
          spec,
          state.protectiveAlgoId,
        );
        notes.push(...converge.notes);
        state = { ...state, protectiveAlgoId: converge.algoId ?? state.protectiveAlgoId };
        patch.state = state;
        if (converge.externalAlgoIds.length > 0) {
          await alert(
            "trend_external_algos",
            { algo_ids: converge.externalAlgoIds },
            `algos:${[...converge.externalAlgoIds].sort().join(",")}`,
          );
        }
        if (!converge.converged) await alert("trend_reconcile_failed", { stage: "drift", stop_px: state.stopPx }, `drift:${state.stopPx}`);
      } else {
        // Same rule as the open/add paths: the claim loser returns without persisting, so its
        // snapshot (with the pre-converge protective algo id) cannot roll back the winner's.
        notes.push("reconcile_claimed_elsewhere");
        return { id: instance.id, instId: instance.instId, action, notes };
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
  alert: (kind: string, payload: Record<string, unknown>, occurrence?: string) => Promise<void>;
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

  // Close only this instance's own tracked size, never the account aggregate: in net mode the
  // row can carry someone else's exposure on top of ours, and that part is not ours to close.
  const observedSz = Math.abs(position.pos);
  const ownSz = state.positionSz > 0 ? Math.min(state.positionSz, observedSz) : observedSz;
  if (!(ownSz > 0)) {
    events.push({ instanceId: instance.id, kind: "position_gone", detail: { during: reason } });
    return { ...state, positionSz: 0, exitReason: reason };
  }
  const sz = formatToStep(ownSz, spec.lotSz);
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
      await alert("trend_close_failed", { outcome: describeOutcome(outcome), reason }, `${lastBar.ts}:${reason}`);
    }
    notes.push(`close_failed:${describeOutcome(outcome)}`);
    return null;
  }

  const after = await deps.exchange.accountState(instance.instId);
  const remaining = findPosition(after, instance);
  const remainingSz = remaining ? Math.abs(remaining.pos) : 0;
  // Success is the position shrinking by exactly our size; anything left up to that is external
  // exposure that was never ours, not a failed close.
  const expectedRemaining = Math.max(0, observedSz - ownSz);
  if (remainingSz > expectedRemaining + spec.lotSz / 2) {
    events.push({ instanceId: instance.id, kind: "close_unverified", detail: { ordId: outcome.ordId } });
    await alert("trend_close_failed", { outcome: "acked_but_position_remains", ordId: outcome.ordId }, `${lastBar.ts}:${reason}`);
    notes.push("close_acked_but_position_remains:check_okx");
    return null;
  }
  // Sweep our protective algos. Flat account: every protective algo on this side is an orphan.
  // External size remains: only the algos at this instance's own stop are identifiably ours —
  // the rest may be protecting the remaining position and stay untouched.
  const allProtective = protectiveAlgos(after.algos, instance.direction, instance.posSide);
  const orphans =
    remainingSz === 0
      ? allProtective
      : state.stopPx === null
        ? []
        : allProtective.filter(
            (algo) => roundToStep(Number(algo.slTriggerPx), spec.tickSz) === roundToStep(state.stopPx!, spec.tickSz),
          );
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
    // The live-trading switch gates only instances that can submit. Shadow instances never call
    // order-submit — they are the safe way to observe the strategy before trading is enabled —
    // so they keep evaluating while live submissions are switched off.
    const liveBlocked = deps.mode === "live" && !deps.liveEnabled && !deps.dryRun;

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
      if (liveBlocked && instance.runMode === "live") {
        reports.push({ id: instance.id, instId: instance.instId, action: "none", notes: ["live_disabled"] });
        continue;
      }
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
      liveDisabled: liveBlocked,
      instances: instances.length,
      reports,
      durationMs: now() - started,
    });
  };
}
