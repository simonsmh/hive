import { isAuthorized } from "./core/auth.ts";

export const SOURCE = "hive:strategy-executor";
export const INTENT_SCHEMA = "okx.intent.v1";
export const INTENT_TTL_SEC = 120;
/** Alerts older than this are skipped, never backfilled. */
export const STALE_MS = 15 * 60_000;
export const SUBMIT_TIMEOUT_MS = 15_000;
export const BATCH_LIMIT = 20;

export type RunStatus =
  | "processing"
  | "acked"
  | "rejected"
  | "failed"
  | "skipped_stale"
  | "skipped_cooldown"
  | "skipped_live_disabled";

export interface ExecutionBinding {
  id: string;
  name: string;
  ruleId: string;
  action: string;
  instId: string;
  side: string;
  posSide: string;
  tdMode: string;
  lever: number | null;
  sz: string;
  ordType: string;
  px: string | null;
  reduceOnly: boolean;
  slTriggerPx: string | null;
  slOrdPx: string | null;
  tpTriggerPx: string | null;
  tpOrdPx: string | null;
  theme: string | null;
  themeStopCapU: number | null;
  maxLossU: number | null;
  marginAmt: string | null;
  reason: string | null;
  cooldownSeconds: number;
  notifySubscriptionId: string | null;
  lastExecutedAtMs: number | null;
  createdAtMs: number;
}

export interface TriggerAlert {
  id: number;
  ruleId: string;
  symbol: string;
  kind: string;
  triggeredAtMs: number;
}

export interface ExecutionRun {
  id: string;
  bindingId: string;
  alertId: number;
}

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

export interface ExecutorStore {
  killSwitchEngaged(): Promise<boolean>;
  listEnabledBindings(): Promise<ExecutionBinding[]>;
  /** Alerts for one rule at or after `sinceMs`, ascending, capped by `limit`. */
  unprocessedAlerts(ruleId: string, sinceMs: number, limit: number): Promise<TriggerAlert[]>;
  /** Alert ids that already have a run for this binding. */
  runAlertIds(bindingId: string): Promise<number[]>;
  /** Insert a run row. False when the (binding, alert) pair already has one. */
  insertRun(bindingId: string, alertId: number, idempotencyKey: string, status: RunStatus): Promise<{ inserted: boolean; runId: string | null }>;
  finishRun(runId: string, status: RunStatus, outcome: Partial<Pick<SubmitOutcome, "ordId" | "algoId" | "reason" | "detail">>): Promise<void>;
  markBindingExecuted(bindingId: string, executedAtMs: number): Promise<void>;
  /** Queue a Telegram receipt through the existing dispatcher queue. */
  queueReceipt(subscriptionId: string, eventKey: string, payload: Record<string, unknown>): Promise<void>;
}

export interface ExecutorDeps {
  cronSecret: string | undefined;
  mode: "demo" | "live";
  liveEnabled: boolean;
  store: ExecutorStore;
  submitter: OrderSubmitter;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ExecutionSummary {
  status: "ok" | "killed";
  bindings: number;
  candidates: number;
  executed: number;
  acked: number;
  rejected: number;
  failed: number;
  skippedStale: number;
  skippedCooldown: number;
  skippedLiveDisabled: number;
  duplicates: number;
  durationMs: number;
}

const MAX_ERROR_LENGTH = 300;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/** Deterministic per (binding, alert): replays can never mint a second order. */
export function executionIdempotencyKey(bindingId: string, alertId: number): string {
  return `exec:${bindingId}:${alertId}`;
}

export function buildIntent(
  binding: ExecutionBinding,
  runId: string,
  idempotencyKey: string,
  createdAtMs: number,
): Record<string, unknown> {
  return {
    schema: INTENT_SCHEMA,
    intentId: `exec-${runId}`,
    idempotencyKey,
    action: binding.action,
    instId: binding.instId,
    side: binding.side,
    posSide: binding.posSide,
    tdMode: binding.tdMode,
    lever: binding.lever,
    sz: binding.sz,
    ordType: binding.ordType,
    px: binding.px,
    reduceOnly: binding.reduceOnly,
    slTriggerPx: binding.slTriggerPx,
    slOrdPx: binding.slOrdPx,
    tpTriggerPx: binding.tpTriggerPx,
    tpOrdPx: binding.tpOrdPx,
    theme: binding.theme,
    themeStopCapU: binding.themeStopCapU,
    maxLossU: binding.maxLossU,
    marginAmt: binding.marginAmt,
    reason: binding.reason ?? binding.name,
    source: SOURCE,
    createdAt: new Date(createdAtMs).toISOString(),
    ttlSec: INTENT_TTL_SEC,
  };
}

function outcomeToRunStatus(outcome: SubmitOutcome): RunStatus {
  if (outcome.status === "acked") return "acked";
  if (outcome.status === "rejected_risk" || outcome.status === "rejected_auth" || outcome.status === "rejected_invalid" || outcome.status === "expired") return "rejected";
  return "failed";
}

function receiptPayload(
  binding: ExecutionBinding,
  alert: TriggerAlert,
  runId: string,
  status: RunStatus,
  outcome: SubmitOutcome | null,
  triggeredAtMs: number,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    action: binding.action,
    inst_id: binding.instId,
    sz: binding.sz,
    status,
    ord_id: outcome?.ordId ?? null,
    algo_id: outcome?.algoId ?? null,
    reason: outcome?.reason ?? null,
  };
  return {
    type: "alert",
    id: runId,
    kind: "strategy_execution",
    severity: status === "acked" ? "warning" : "critical",
    symbol: alert.symbol,
    source: SOURCE,
    triggered_at: new Date(triggeredAtMs).toISOString(),
    payload: {
      bar_ts: new Date(alert.triggeredAtMs).toISOString(),
      binding_name: binding.name,
      rule_id: binding.ruleId,
      alert_id: alert.id,
      details,
    },
  };
}

/**
 * Turns enabled bindings' new alerts into order-submit intents, one run per
 * (binding, alert). Order-submit's own gates (kill switch, risk limits,
 * rate limit, idempotency window) still apply to every intent; this
 * function adds the executor-side guards: staleness, binding cooldown,
 * live switch, and exactly-once claiming via the runs unique guard.
 */
export function createStrategyExecutorHandler(deps: ExecutorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[strategy-executor] ${message}`));

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const started = now();
    const summary: ExecutionSummary = {
      status: "ok",
      bindings: 0,
      candidates: 0,
      executed: 0,
      acked: 0,
      rejected: 0,
      failed: 0,
      skippedStale: 0,
      skippedCooldown: 0,
      skippedLiveDisabled: 0,
      duplicates: 0,
      durationMs: 0,
    };

    let killed: boolean;
    try {
      killed = await deps.store.killSwitchEngaged();
    } catch (error) {
      log(`kill switch read failed: ${describeError(error)}`);
      return json(500, { error: "kill switch read failed" });
    }
    if (killed) {
      // Pause, do not consume: alerts stay unprocessed and are picked up
      // later while still fresh, or skipped as stale after the window.
      summary.status = "killed";
      summary.durationMs = now() - started;
      log("kill switch engaged, paused");
      return json(200, summary);
    }

    let bindings: ExecutionBinding[];
    try {
      bindings = await deps.store.listEnabledBindings();
    } catch (error) {
      log(`bindings read failed: ${describeError(error)}`);
      return json(500, { error: "bindings read failed" });
    }
    summary.bindings = bindings.length;

    for (const binding of bindings) {
      let alerts: TriggerAlert[];
      let seen: number[];
      try {
        [alerts, seen] = await Promise.all([
          deps.store.unprocessedAlerts(binding.ruleId, binding.createdAtMs, BATCH_LIMIT),
          deps.store.runAlertIds(binding.id),
        ]);
      } catch (error) {
        log(`binding ${binding.name} read failed: ${describeError(error)}`);
        continue;
      }
      const seenSet = new Set(seen);
      for (const alert of alerts) {
        if (seenSet.has(alert.id)) continue;
        summary.candidates += 1;
        const nowMs = now();
        const key = executionIdempotencyKey(binding.id, alert.id);

        if (nowMs - alert.triggeredAtMs > STALE_MS) {
          const claimed = await deps.store.insertRun(binding.id, alert.id, key, "skipped_stale");
          if (claimed.inserted) summary.skippedStale += 1;
          else summary.duplicates += 1;
          continue;
        }
        if (binding.lastExecutedAtMs !== null && nowMs - binding.lastExecutedAtMs < binding.cooldownSeconds * 1000) {
          const claimed = await deps.store.insertRun(binding.id, alert.id, key, "skipped_cooldown");
          if (claimed.inserted) summary.skippedCooldown += 1;
          else summary.duplicates += 1;
          continue;
        }
        if (deps.mode === "live" && !deps.liveEnabled) {
          const claimed = await deps.store.insertRun(binding.id, alert.id, key, "skipped_live_disabled");
          if (claimed.inserted) summary.skippedLiveDisabled += 1;
          else summary.duplicates += 1;
          continue;
        }

        let run: { inserted: boolean; runId: string | null };
        try {
          run = await deps.store.insertRun(binding.id, alert.id, key, "processing");
        } catch (error) {
          log(`binding ${binding.name} alert ${alert.id} claim failed: ${describeError(error)}`);
          continue;
        }
        if (!run.inserted || run.runId === null) {
          summary.duplicates += 1;
          continue;
        }
        // Cooldown is consumed on claim, so a rejected submit does not
        // retry every poll cycle.
        try {
          await deps.store.markBindingExecuted(binding.id, nowMs);
          binding.lastExecutedAtMs = nowMs;
        } catch (error) {
          log(`binding ${binding.name} cooldown mark failed: ${describeError(error)}`);
        }

        let outcome: SubmitOutcome;
        try {
          outcome = await deps.submitter.submit(buildIntent(binding, run.runId, key, nowMs));
        } catch (error) {
          outcome = { httpStatus: null, status: "transport_error", reason: describeError(error), ordId: null, algoId: null, detail: null };
        }
        const status = outcomeToRunStatus(outcome);
        try {
          await deps.store.finishRun(run.runId, status, outcome);
        } catch (error) {
          log(`run ${run.runId} finish failed: ${describeError(error)}`);
        }
        summary.executed += 1;
        if (status === "acked") summary.acked += 1;
        else if (status === "rejected") summary.rejected += 1;
        else summary.failed += 1;
        log(`binding=${binding.name} alert=${alert.id} status=${status} reason=${outcome.reason ?? "-"} ordId=${outcome.ordId ?? "-"} algoId=${outcome.algoId ?? "-"}`);

        if (binding.notifySubscriptionId !== null) {
          try {
            await deps.store.queueReceipt(
              binding.notifySubscriptionId,
              `exec:${run.runId}`,
              receiptPayload(binding, alert, run.runId, status, outcome, nowMs),
            );
          } catch (error) {
            log(`run ${run.runId} receipt queue failed: ${describeError(error)}`);
          }
        }
      }
    }

    summary.durationMs = now() - started;
    return json(200, summary);
  };
}
