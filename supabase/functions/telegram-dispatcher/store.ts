import type {
  TelegramCandle,
  TelegramCandleQuery,
  TelegramDeliveryOutcome,
  TelegramDispatchStore,
  TelegramDueDelivery,
} from "./handler.ts";

const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only ever sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface ClaimRow {
  delivery_id: number | string;
  chat_id: string;
  bot_token: string | null;
  event_type: string;
  payload: unknown;
  attempts: number | string;
  max_attempts: number | string;
}

interface CandleRow {
  ts: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
}

/**
 * PostgREST RPC store. hive_telegram_claim returns the Vault-decrypted bot
 * token, so rows are only ever handled in memory here and never logged.
 */
export function createRestTelegramStore(options: RestStoreOptions): TelegramDispatchStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: options.serviceKey,
        authorization: `Bearer ${options.serviceKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST ${name} returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /** Latest `limit` confirmed bars for a series, oldest first. Read-only; used only to draw the chart. */
  async function recentCandles(query: TelegramCandleQuery): Promise<TelegramCandle[]> {
    const params = new URLSearchParams({
      select: "ts,open,high,low,close",
      symbol: `eq.${query.symbol}`,
      source: `eq.${query.source}`,
      interval: `eq.${query.interval}`,
      confirmed: "eq.true",
      order: "ts.desc",
      limit: String(Math.max(1, Math.min(query.limit, 200))),
    });
    const response = await fetchImpl(`${base}/rest/v1/candles?${params.toString()}`, {
      method: "GET",
      headers: {
        apikey: options.serviceKey,
        authorization: `Bearer ${options.serviceKey}`,
        accept: "application/json",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST candles returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    const rows = (text ? JSON.parse(text) : []) as CandleRow[];
    return rows
      .map((row) => ({
        ts: Date.parse(row.ts),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
      }))
      .reverse();
  }
  return {
    candles: recentCandles,
    async claim(limit: number, leaseSeconds: number): Promise<TelegramDueDelivery[]> {
      const rows = ((await rpc("hive_telegram_claim", { p_limit: limit, p_lease_seconds: leaseSeconds })) ?? []) as ClaimRow[];
      return rows.map((row) => ({
        deliveryId: Number(row.delivery_id),
        chatId: row.chat_id,
        botToken: row.bot_token ?? null,
        eventType: row.event_type,
        payload: row.payload,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
      }));
    },

    async release(deliveryIds: number[]): Promise<void> {
      if (deliveryIds.length === 0) return;
      await rpc("hive_telegram_release", { p_delivery_ids: deliveryIds });
    },

    async mark(deliveryId: number, outcome: TelegramDeliveryOutcome): Promise<string> {
      const status = await rpc("hive_telegram_mark", {
        p_delivery_id: deliveryId,
        p_ok: outcome.ok,
        p_response_status: outcome.responseStatus,
        p_error: outcome.error === null ? null : outcome.error.slice(0, MAX_ERROR_LENGTH),
        p_backoff_seconds: outcome.backoffSeconds,
      });
      return typeof status === "string" ? status : "unknown";
    },
  };
}
