import { isAuthorized } from "./core/auth.ts";
import {
  computeTelegramBackoffSeconds,
  type TelegramChartCandle,
  type TelegramChartInput,
  deliverTelegramAlert,
  formatTelegramAlertMessage,
  TELEGRAM_API_BASE_URL,
  TELEGRAM_CHART_MAX_BARS,
  TELEGRAM_MAX_BACKOFF_SECONDS,
} from "./core/telegram.ts";

export interface TelegramDueDelivery {
  deliveryId: number;
  chatId: string;
  /** Null when the subscription's Vault bot token is missing; such deliveries are never sent. */
  botToken: string | null;
  eventType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface TelegramDeliveryOutcome {
  ok: boolean;
  responseStatus: number | null;
  error: string | null;
  backoffSeconds: number;
  /** True when the alert went out as a photo with caption; false for the text-only path. */
  withPhoto?: boolean;
}

export interface TelegramCandleQuery {
  symbol: string;
  source: string;
  interval: string;
  limit: number;
}

/** One confirmed bar for the chart. Read-only: nothing here reaches the alert or trading path. */
export type TelegramCandle = TelegramChartCandle;

export interface TelegramDispatchStore {
  claim(limit: number, leaseSeconds: number): Promise<TelegramDueDelivery[]>;
  mark(deliveryId: number, outcome: TelegramDeliveryOutcome): Promise<string>;
  /** Returns claimed deliveries to pending and refunds the attempt that claiming counted. */
  release(deliveryIds: number[]): Promise<void>;
  /**
   * Confirmed bars for the chart, oldest first. Optional: without it alerts go out as text only. A rejection
   * means "no chart", never a lost delivery.
   */
  candles?(query: TelegramCandleQuery): Promise<TelegramCandle[]>;
}

export interface TelegramDispatcherDeps {
  cronSecret: string | undefined;
  store: TelegramDispatchStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  batchSize?: number;
  concurrency?: number;
  budgetMs?: number;
  leaseSeconds?: number;
  requestTimeoutMs?: number;
}

export interface TelegramDispatchSummary {
  status: "idle" | "ok" | "error";
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
  skipped: number;
  durationMs: number;
}

export const BATCH_SIZE = 20;
export const CONCURRENCY = 4;
export const BUDGET_MS = 90_000;
export const LEASE_SECONDS = 120;
export const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ERROR_LENGTH = 300;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createTelegramDispatcher(deps: TelegramDispatcherDeps): (request: Request) => Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[telegram-dispatcher] ${message}`));
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const concurrency = deps.concurrency ?? CONCURRENCY;
  const budgetMs = deps.budgetMs ?? BUDGET_MS;
  const leaseSeconds = deps.leaseSeconds ?? LEASE_SECONDS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  /**
   * Chart data for one alert, or null when the delivery carries nothing to draw. Reads the alert's own series
   * (source/interval/symbol from the payload) and the anchor/trigger prices the evaluator recorded. Any read
   * failure degrades to null: the alert is still delivered as text.
   */
  async function chartFor(due: TelegramDueDelivery): Promise<TelegramChartInput | null> {
    if (!deps.store.candles) return null;
    const payload = asRecord(due.payload);
    const inner = asRecord(payload?.payload);
    // Evaluator rows carry the numbers flat on payload (payload.last_price, ...); webhook-era
    // rows wrap them in payload.details. Details wins when both are present, mirroring readAlertView.
    const details = asRecord(inner?.details) ?? inner;
    if (!payload || !details) return null;
    const kind = asString(payload.kind);
    if (kind !== "retracement" && kind !== "volume_spike") return null;
    const symbol = asString(payload.symbol);
    const source = asString(payload.source) ?? asString(inner?.source);
    const interval = asString(inner?.interval);
    if (!symbol || !source || !interval) return null;
    const barTs = asString(inner?.bar_ts) ?? (typeof inner?.barTs === "number" ? inner.barTs : null);
    let candles: TelegramCandle[];
    try {
      candles = await deps.store.candles({ symbol, source, interval, limit: TELEGRAM_CHART_MAX_BARS });
    } catch (error) {
      log(`delivery=${due.deliveryId} chart candles unavailable: ${describeError(error)}`);
      return null;
    }
    if (candles.length < 2) return null;
    // Only the bars up to and including the triggering one: a late delivery must not show future bars.
    const cutoff = typeof barTs === "string" ? Date.parse(barTs) : null;
    const bounded = cutoff !== null && Number.isFinite(cutoff)
      ? candles.filter((bar) => bar.ts <= cutoff)
      : candles;
    if (bounded.length < 2) return null;
    const triggerPrice = asNumber(details.last_price);
    if (kind === "retracement") {
      return {
        candles: bounded,
        anchorPrice: asNumber(details.anchor_price),
        anchorLabel: details.is_top === 1 ? "高点锚" : details.is_top === 0 ? "低点锚" : "锚",
        triggerPrice,
      };
    }
    // volume_spike has no price level to draw: the chart carries candles plus the trigger bar marker.
    return { candles: bounded, triggerPrice };
  }

  async function attempt(due: TelegramDueDelivery): Promise<TelegramDeliveryOutcome> {
    if (due.botToken === null) {
      return {
        ok: false,
        responseStatus: null,
        error: "subscription has no bot token; not sent",
        backoffSeconds: TELEGRAM_MAX_BACKOFF_SECONDS,
      };
    }
    const text = formatTelegramAlertMessage(due.payload);
    const chart = await chartFor(due);
    const result = await deliverTelegramAlert(
      fetchImpl,
      TELEGRAM_API_BASE_URL,
      due.botToken,
      due.chatId,
      text,
      chart,
      requestTimeoutMs,
    );
    if (result.ok) {
      if (result.photoError !== null) {
        log(`delivery=${due.deliveryId} photo failed, sent as text: ${result.photoError}`);
      }
      return {
        ok: true,
        responseStatus: result.status,
        error: null,
        backoffSeconds: 0,
        withPhoto: result.withPhoto,
      };
    }
    const backoff = Math.max(
      computeTelegramBackoffSeconds(due.attempts),
      result.retryAfterSeconds ?? 0,
    );
    return {
      ok: false,
      responseStatus: result.status,
      error: result.error,
      backoffSeconds: backoff,
      withPhoto: false,
    };
  }

  /** Sends one delivery and records the outcome. Never throws. */
  async function deliver(due: TelegramDueDelivery): Promise<string> {
    const outcome = await attempt(due);
    try {
      const status = await deps.store.mark(due.deliveryId, outcome);
      log(`delivery=${due.deliveryId} attempt=${due.attempts} result=${status}${outcome.error ? ` error="${outcome.error}"` : ""}`);
      return status;
    } catch (error) {
      log(`delivery=${due.deliveryId} could not record outcome: ${describeError(error)}`);
      return "mark_failed";
    }
  }

  async function release(items: TelegramDueDelivery[]): Promise<void> {
    if (items.length === 0) return;
    try {
      await deps.store.release(items.map((item) => item.deliveryId));
    } catch (error) {
      log(`release failed for ${items.length} deliveries: ${describeError(error)}`);
    }
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const started = now();
    const summary: TelegramDispatchSummary = {
      status: "idle",
      claimed: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
      durationMs: 0,
    };

    for (;;) {
      let due: TelegramDueDelivery[];
      try {
        due = await deps.store.claim(batchSize, leaseSeconds);
      } catch (error) {
        log(`claim failed: ${describeError(error)}`);
        if (summary.claimed === 0) return json(500, { status: "error", error: "could not claim deliveries" });
        break;
      }
      summary.claimed += due.length;

      for (let i = 0; i < due.length; i += concurrency) {
        const elapsed = now() - started;
        if (elapsed > budgetMs) {
          const rest = due.slice(i);
          summary.skipped += rest.length;
          await release(rest);
          summary.durationMs = now() - started;
          return json(200, { ...summary, status: "ok" });
        }
        const chunk = due.slice(i, i + concurrency);
        const statuses = await Promise.all(chunk.map((item) => deliver(item)));
        for (const status of statuses) {
          if (status === "delivered") summary.delivered += 1;
          else if (status === "dead") summary.dead += 1;
          else if (status === "mark_failed") summary.failed += 1;
          else summary.failed += 1;
        }
      }

      if (due.length < batchSize) break;
    }

    summary.durationMs = now() - started;
    return json(200, { ...summary, status: "ok" });
  };
}
