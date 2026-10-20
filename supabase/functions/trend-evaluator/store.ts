import type { PositionMode } from "./core/position.ts";
import type { Candle } from "./core/types.ts";
import type {
  AlertInsert,
  TrendEventInsert,
  TrendInstanceRow,
  TrendPatch,
  TrendStore,
} from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface TrendInstanceDbRow {
  id: string;
  mode: PositionMode;
  run_mode: TrendInstanceRow["runMode"];
  inst_id: string;
  symbol: string;
  direction: TrendInstanceRow["direction"];
  pos_side: TrendInstanceRow["posSide"];
  td_mode: TrendInstanceRow["tdMode"];
  lever: number | string;
  first_sz: number | string;
  theme: string;
  theme_stop_cap_u: number | string;
  params: unknown;
  state: unknown;
  status: TrendInstanceRow["status"];
  expires_at: string;
}

interface CandleDbRow {
  ts: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
  vol_ccy: number | string;
}

function toInstance(row: TrendInstanceDbRow): TrendInstanceRow {
  return {
    id: row.id,
    mode: row.mode,
    runMode: row.run_mode,
    instId: row.inst_id,
    symbol: row.symbol,
    direction: row.direction,
    posSide: row.pos_side,
    tdMode: row.td_mode,
    lever: Number(row.lever),
    firstSz: String(row.first_sz),
    theme: row.theme,
    themeStopCapU: Number(row.theme_stop_cap_u),
    params: row.params,
    state: row.state,
    status: row.status,
    expiresAtMs: Date.parse(row.expires_at),
  };
}

function patchColumns(patch: TrendPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = {
    last_eval_at: patch.lastEvalAt,
    last_note: patch.lastNote,
    updated_at: patch.lastEvalAt,
  };
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.state !== undefined) columns.state = patch.state;
  return columns;
}

/**
 * PostgREST-backed store. Reads and eval records use the service role on trend_strategies and
 * candles. Action leases go through the security-definer claim RPC, so only one run can submit for
 * an instance. Events are append-only inserts into trend_strategy_events.
 */
export function createRestTrendStore(options: RestStoreOptions): TrendStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
      ...extraHeaders,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST ${method} ${path.split("?")[0]} returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    async killSwitchEngaged(): Promise<boolean> {
      const rows = (await request("GET", "/rest/v1/kill_switch?select=engaged&id=eq.1")) as { engaged: boolean }[];
      return rows[0]?.engaged !== false;
    },

    async listActiveInstances(mode: PositionMode): Promise<TrendInstanceRow[]> {
      const query = new URLSearchParams({
        select: "*",
        mode: `eq.${mode}`,
        status: "in.(armed,active)",
        order: "created_at.asc",
      });
      const rows = (await request("GET", `/rest/v1/trend_strategies?${query.toString()}`)) as TrendInstanceDbRow[];
      return rows.map(toInstance);
    },

    async confirmedCandles(symbol: string, interval: "5m", limit: number): Promise<Candle[]> {
      const query = new URLSearchParams({
        select: "ts,open,high,low,close,volume,vol_ccy",
        symbol: `eq.${symbol}`,
        source: "eq.okx",
        interval: `eq.${interval}`,
        confirmed: "eq.true",
        order: "ts.desc",
        limit: String(limit),
      });
      const rows = (await request("GET", `/rest/v1/candles?${query.toString()}`)) as CandleDbRow[];
      return rows
        .map((row): Candle => {
          const ts = Date.parse(row.ts);
          if (Number.isNaN(ts)) throw new Error(`candle ts is not a timestamp: ${row.ts}`);
          return {
            ts,
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume),
            volCcy: Number(row.vol_ccy),
            confirmed: true,
          };
        })
        .reverse();
    },

    async recordEval(id: string, patch: TrendPatch): Promise<void> {
      // Only live rows may be rewritten by an evaluation: a terminal row (done/expired/cancelled/
      // failed) must never be resurrected by a stale in-flight evaluation.
      const query = new URLSearchParams({ id: `eq.${id}`, status: "in.(armed,active)" });
      await request("PATCH", `/rest/v1/trend_strategies?${query.toString()}`, patchColumns(patch), {
        prefer: "return=minimal",
      });
    },

    async getInstance(id: string): Promise<TrendInstanceRow | null> {
      const query = new URLSearchParams({ select: "*", id: `eq.${id}` });
      const rows = (await request("GET", `/rest/v1/trend_strategies?${query.toString()}`)) as TrendInstanceDbRow[];
      return rows[0] ? toInstance(rows[0]) : null;
    },

    async claim(id: string, leaseSeconds: number): Promise<boolean> {
      return (
        (await request("POST", "/rest/v1/rpc/hive_trend_claim", { p_id: id, p_lease_seconds: leaseSeconds })) === true
      );
    },

    async insertEvent(event: TrendEventInsert): Promise<void> {
      await request(
        "POST",
        "/rest/v1/trend_strategy_events",
        { instance_id: event.instanceId, kind: event.kind, detail: event.detail },
        { prefer: "return=minimal" },
      );
    },

    async insertAlert(alert: AlertInsert): Promise<void> {
      await request("POST", "/rest/v1/alerts", alert, {
        prefer: "resolution=ignore-duplicates,return=minimal",
      });
    },
  };
}
