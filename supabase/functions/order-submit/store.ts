import type { RiskLimitsView, TradeMode } from "./core/order-intent.ts";
import type {
  InsertResult,
  IntentOutcome,
  IntentRecord,
  OrderRecord,
  OrderStore,
  StoredIntent,
} from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface RiskLimitsDbRow {
  symbol_allowlist: string[];
  max_notional_usdt: number | string;
  max_leverage: number | string;
  max_orders_per_min: number | string;
}

interface StoredIntentDbRow {
  status: StoredIntent["status"];
  reject_reason: string | null;
  ord_id: string | null;
  algo_id: string | null;
  cl_ord_id: string;
  detail: string | null;
  received_at: string;
}

function toStored(row: StoredIntentDbRow): StoredIntent {
  return {
    status: row.status,
    reason: row.reject_reason,
    ordId: row.ord_id,
    algoId: row.algo_id,
    clOrdId: row.cl_ord_id,
    state: null,
    detail: row.detail,
    receivedAtMs: Date.parse(row.received_at),
  };
}

function intentColumns(record: IntentRecord): Record<string, unknown> {
  return {
    intent_id: record.intentId,
    idempotency_key: record.idempotencyKey,
    mode: record.mode,
    schema_version: record.schemaVersion,
    action: record.action,
    source: record.source,
    inst_id: record.instId,
    side: record.side,
    pos_side: record.posSide,
    td_mode: record.tdMode,
    lever: record.lever,
    sz: record.sz,
    ord_type: record.ordType,
    px: record.px,
    reduce_only: record.reduceOnly,
    sl_trigger_px: record.slTriggerPx,
    sl_ord_px: record.slOrdPx,
    tp_trigger_px: record.tpTriggerPx,
    tp_ord_px: record.tpOrdPx,
    theme: record.theme,
    theme_stop_cap_u: record.themeStopCapU,
    max_loss_u: record.maxLossU,
    reason: record.reason,
    intent_created_at: record.intentCreatedAt,
    ttl_sec: record.ttlSec,
    cl_ord_id: record.clOrdId,
    request: record.request,
  };
}

function orderColumns(record: OrderRecord): Record<string, unknown> {
  return {
    intent_id: record.intentId,
    mode: record.mode,
    action: record.action,
    kind: record.kind,
    inst_id: record.instId,
    side: record.side,
    pos_side: record.posSide,
    ord_type: record.ordType,
    ord_id: record.ordId,
    algo_id: record.algoId,
    cl_ord_id: record.clOrdId,
    sz: record.sz,
    px: record.px,
    state: record.state,
  };
}

/**
 * PostgREST-backed store. Reads use the service role on the risk tables. Writes go through security-definer RPCs:
 * the intent insert is one statement that either creates the row or returns the existing one, so the idempotency
 * check and the write cannot race each other.
 */
export function createRestOrderStore(options: RestStoreOptions): OrderStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
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

  function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    return request("POST", `/rest/v1/rpc/${name}`, args);
  }

  return {
    async killSwitchEngaged(): Promise<boolean> {
      const rows = (await request("GET", "/rest/v1/kill_switch?select=engaged&id=eq.1")) as { engaged: boolean }[];
      return rows[0]?.engaged !== false;
    },

    async riskLimits(mode: TradeMode): Promise<RiskLimitsView | null> {
      const query = new URLSearchParams({
        select: "symbol_allowlist,max_notional_usdt,max_leverage,max_orders_per_min",
        mode: `eq.${mode}`,
        enabled: "eq.true",
        limit: "1",
      });
      const rows = (await request("GET", `/rest/v1/risk_limits?${query.toString()}`)) as RiskLimitsDbRow[];
      const row = rows[0];
      if (!row) return null;
      return {
        symbolAllowlist: row.symbol_allowlist,
        maxNotionalUsdt: Number(row.max_notional_usdt),
        maxLeverage: Number(row.max_leverage),
        maxOrdersPerMin: Number(row.max_orders_per_min),
      };
    },

    async hasEnabledSubscription(mode: TradeMode, instId: string): Promise<boolean> {
      const query = new URLSearchParams({
        select: "id",
        mode: `eq.${mode}`,
        inst_id: `eq.${instId}`,
        enabled: "eq.true",
        limit: "1",
      });
      const rows = (await request("GET", `/rest/v1/position_subscriptions?${query.toString()}`)) as { id: string }[];
      return rows.length > 0;
    },

    async insertIntent(record: IntentRecord): Promise<InsertResult> {
      const result = (await rpc("hive_order_intent_insert", { p_intent: intentColumns(record) })) as {
        inserted: boolean;
        row: StoredIntentDbRow | null;
      };
      if (result.inserted) return { inserted: true };
      return { inserted: false, existing: result.row ? toStored(result.row) : null };
    },

    async finishIntent(idempotencyKey: string, outcome: IntentOutcome): Promise<void> {
      await rpc("hive_order_intent_finish", {
        p_idempotency_key: idempotencyKey,
        p_result: {
          status: outcome.status,
          reason: outcome.reason,
          ord_id: outcome.ordId,
          algo_id: outcome.algoId,
          cl_ord_id: outcome.clOrdId,
          detail: outcome.detail,
        },
      });
    },

    async submissionsSince(mode: TradeMode, sinceMs: number, excludeIdempotencyKey: string): Promise<number> {
      const count = await rpc("hive_order_submissions_since", {
        p_mode: mode,
        p_since: new Date(sinceMs).toISOString(),
        p_exclude_key: excludeIdempotencyKey,
      });
      return Number(count ?? 0);
    },

    async recordOrder(record: OrderRecord): Promise<void> {
      await rpc("hive_order_record", { p_order: orderColumns(record) });
    },

    async liveAlgos(instId: string, mode: TradeMode): Promise<{ algoId: string; clOrdId: string }[]> {
      const query = new URLSearchParams({
        select: "algo_id,cl_ord_id",
        exchange: "eq.okx",
        kind: "eq.algo",
        state: "in.(accepted,live)",
        inst_id: `eq.${instId}`,
        mode: `eq.${mode}`,
        algo_id: "not.is.null",
      });
      const rows = (await request("GET", `/rest/v1/orders?${query.toString()}`)) as {
        algo_id: string;
        cl_ord_id: string;
      }[];
      return rows.map((row) => ({ algoId: row.algo_id, clOrdId: row.cl_ord_id }));
    },

    async setOrderState(clOrdId: string, state: string): Promise<void> {
      await rpc("hive_order_set_state", { p_cl_ord_id: clOrdId, p_state: state });
    },
  };
}
