import type { PositionMode } from "./core/position.ts";
import type { Candle } from "./core/types.ts";
import type { AlertInsert, ConditionalOrderRow, OrderPatch, StrategyStore } from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface ConditionalOrderDbRow {
  id: string;
  mode: PositionMode;
  inst_id: string;
  symbol: string;
  template: string;
  pos_side: ConditionalOrderRow["posSide"];
  td_mode: ConditionalOrderRow["tdMode"];
  lever: number | string;
  sz: number | string;
  theme: string;
  theme_stop_cap_u: number | string;
  tp_pct: number | string | null;
  params: unknown;
  status: ConditionalOrderRow["status"];
  setup_low: number | string | null;
  setup_low_ts: string | null;
  drawdown_pct: number | string | null;
  invalidations: number | string;
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

function toOrder(row: ConditionalOrderDbRow): ConditionalOrderRow {
  return {
    id: row.id,
    mode: row.mode,
    instId: row.inst_id,
    symbol: row.symbol,
    template: row.template,
    posSide: row.pos_side,
    tdMode: row.td_mode,
    lever: Number(row.lever),
    sz: String(row.sz),
    theme: row.theme,
    themeStopCapU: Number(row.theme_stop_cap_u),
    tpPct: row.tp_pct === null ? null : Number(row.tp_pct),
    params: row.params,
    status: row.status,
    setupLow: row.setup_low === null ? null : Number(row.setup_low),
    setupLowTs: row.setup_low_ts ? Date.parse(row.setup_low_ts) : null,
    drawdownPct: row.drawdown_pct === null ? null : Number(row.drawdown_pct),
    invalidations: Number(row.invalidations),
    expiresAtMs: Date.parse(row.expires_at),
  };
}

function patchColumns(patch: OrderPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = {
    last_eval_at: patch.lastEvalAt,
    last_note: patch.lastNote,
    updated_at: patch.lastEvalAt,
  };
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.setupLow !== undefined) columns.setup_low = patch.setupLow;
  if (patch.setupLowTs !== undefined) columns.setup_low_ts = patch.setupLowTs;
  if (patch.setupAt !== undefined) columns.setup_at = patch.setupAt;
  if (patch.refHigh !== undefined) columns.ref_high = patch.refHigh;
  if (patch.drawdownPct !== undefined) columns.drawdown_pct = patch.drawdownPct;
  if (patch.invalidations !== undefined) columns.invalidations = patch.invalidations;
  if (patch.fireBarTs !== undefined) columns.fire_bar_ts = patch.fireBarTs;
  if (patch.fireTrigger !== undefined) columns.fire_trigger = patch.fireTrigger;
  if (patch.firedAt !== undefined) columns.fired_at = patch.firedAt;
  if (patch.ordId !== undefined) columns.ord_id = patch.ordId;
  if (patch.algoId !== undefined) columns.algo_id = patch.algoId;
  return columns;
}

/**
 * PostgREST-backed store. Reads and eval records use the service role on conditional_orders and candles.
 * The fire lease goes through the security-definer claim RPC, so only one run can submit for an order.
 * Alert inserts ignore dedup conflicts: the same fire is never announced twice.
 */
export function createRestStrategyStore(options: RestStoreOptions): StrategyStore {
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

    async listActiveOrders(mode: PositionMode): Promise<ConditionalOrderRow[]> {
      const query = new URLSearchParams({
        select: "*",
        mode: `eq.${mode}`,
        status: "in.(armed,primed)",
        order: "created_at.asc",
      });
      const rows = (await request("GET", `/rest/v1/conditional_orders?${query.toString()}`)) as ConditionalOrderDbRow[];
      return rows.map(toOrder);
    },

    async confirmedCandles(symbol: string, interval: "1D" | "15m", limit: number, sinceTs?: number): Promise<Candle[]> {
      const query = new URLSearchParams({
        select: "ts,open,high,low,close,volume,vol_ccy",
        symbol: `eq.${symbol}`,
        source: "eq.okx",
        interval: `eq.${interval}`,
        confirmed: "eq.true",
        order: "ts.desc",
        limit: String(limit),
      });
      if (sinceTs !== undefined) query.set("ts", `gte.${new Date(sinceTs).toISOString()}`);
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

    async recordEval(id: string, patch: OrderPatch): Promise<void> {
      // Only live rows may be rewritten by an evaluation: a terminal row (fired/failed/expired/
      // cancelled) must never be resurrected by a stale in-flight evaluation.
      const query = new URLSearchParams({ id: `eq.${id}`, status: "in.(armed,primed)" });
      await request("PATCH", `/rest/v1/conditional_orders?${query.toString()}`, patchColumns(patch), {
        prefer: "return=minimal",
      });
    },

    async getOrder(id: string): Promise<ConditionalOrderRow | null> {
      const query = new URLSearchParams({ select: "*", id: `eq.${id}` });
      const rows = (await request("GET", `/rest/v1/conditional_orders?${query.toString()}`)) as ConditionalOrderDbRow[];
      return rows[0] ? toOrder(rows[0]) : null;
    },

    async claim(id: string, leaseSeconds: number): Promise<boolean> {
      return (
        (await request("POST", "/rest/v1/rpc/hive_conditional_claim", { p_id: id, p_lease_seconds: leaseSeconds })) === true
      );
    },

    async insertAlert(alert: AlertInsert): Promise<void> {
      await request("POST", "/rest/v1/alerts", alert, {
        prefer: "resolution=ignore-duplicates,return=minimal",
      });
    },
  };
}
