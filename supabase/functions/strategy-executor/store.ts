import type {
  ExecutionBinding,
  ExecutorStore,
  RunStatus,
  TriggerAlert,
} from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only ever sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface BindingDbRow {
  id: string;
  name: string;
  rule_id: string;
  action: string;
  inst_id: string;
  side: string;
  pos_side: string;
  td_mode: string;
  lever: number | string | null;
  sz: string;
  ord_type: string;
  px: string | null;
  reduce_only: boolean;
  sl_trigger_px: string | null;
  sl_ord_px: string | null;
  tp_trigger_px: string | null;
  tp_ord_px: string | null;
  theme: string | null;
  theme_stop_cap_u: number | string | null;
  max_loss_u: number | string | null;
  margin_amt: string | null;
  reason: string | null;
  cooldown_seconds: number | string;
  notify_subscription_id: string | null;
  last_executed_at: string | null;
  created_at: string;
}

interface AlertDbRow {
  id: number | string;
  rule_id: string;
  symbol: string | null;
  kind: string;
  triggered_at: string;
}

function toBinding(row: BindingDbRow): ExecutionBinding {
  return {
    id: row.id,
    name: row.name,
    ruleId: row.rule_id,
    action: row.action,
    instId: row.inst_id,
    side: row.side,
    posSide: row.pos_side,
    tdMode: row.td_mode,
    lever: row.lever === null ? null : Number(row.lever),
    sz: row.sz,
    ordType: row.ord_type,
    px: row.px,
    reduceOnly: row.reduce_only,
    slTriggerPx: row.sl_trigger_px,
    slOrdPx: row.sl_ord_px,
    tpTriggerPx: row.tp_trigger_px,
    tpOrdPx: row.tp_ord_px,
    theme: row.theme,
    themeStopCapU: row.theme_stop_cap_u === null ? null : Number(row.theme_stop_cap_u),
    maxLossU: row.max_loss_u === null ? null : Number(row.max_loss_u),
    marginAmt: row.margin_amt,
    reason: row.reason,
    cooldownSeconds: Number(row.cooldown_seconds),
    notifySubscriptionId: row.notify_subscription_id,
    lastExecutedAtMs: row.last_executed_at === null ? null : Date.parse(row.last_executed_at),
    createdAtMs: Date.parse(row.created_at),
  };
}

/** PostgREST-backed store. Run inserts rely on the (binding, alert) unique guard for exactly-once claiming. */
export function createRestExecutorStore(options: RestStoreOptions): ExecutorStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["Prefer"] = "return=representation";

    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST ${method} ${path.split("?")[0]} returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }

  return {
    async killSwitchEngaged(): Promise<boolean> {
      const { data } = await request("GET", "/rest/v1/kill_switch?select=engaged&id=eq.1");
      const rows = data as { engaged: boolean }[];
      return rows[0]?.engaged !== false;
    },

    async listEnabledBindings(): Promise<ExecutionBinding[]> {
      const { data } = await request(
        "GET",
        "/rest/v1/strategy_executions?select=*&enabled=eq.true&order=created_at.asc",
      );
      return (data as BindingDbRow[]).map(toBinding);
    },

    async unprocessedAlerts(ruleId: string, sinceMs: number, limit: number): Promise<TriggerAlert[]> {
      const query = new URLSearchParams({
        select: "id,rule_id,symbol,kind,triggered_at",
        rule_id: `eq.${ruleId}`,
        triggered_at: `gte.${new Date(sinceMs).toISOString()}`,
        order: "triggered_at.asc",
        limit: String(limit),
      });
      const { data } = await request("GET", `/rest/v1/alerts?${query.toString()}`);
      return (data as AlertDbRow[]).map((row) => ({
        id: Number(row.id),
        ruleId: row.rule_id,
        symbol: row.symbol ?? "",
        kind: row.kind,
        triggeredAtMs: Date.parse(row.triggered_at),
      }));
    },

    async runAlertIds(bindingId: string): Promise<number[]> {
      const query = new URLSearchParams({
        select: "alert_id",
        binding_id: `eq.${bindingId}`,
      });
      const { data } = await request("GET", `/rest/v1/strategy_execution_runs?${query.toString()}`);
      return (data as { alert_id: number | string }[]).map((row) => Number(row.alert_id));
    },

    async insertRun(bindingId: string, alertId: number, idempotencyKey: string, status: RunStatus): Promise<{ inserted: boolean; runId: string | null }> {
      const headers: Record<string, string> = {
        apikey: options.serviceKey,
        authorization: `Bearer ${options.serviceKey}`,
        "content-type": "application/json",
        accept: "application/json",
        Prefer: "return=representation",
      };
      const response = await fetchImpl(`${base}/rest/v1/strategy_execution_runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          binding_id: bindingId,
          alert_id: alertId,
          idempotency_key: idempotencyKey,
          status,
        }),
      });
      if (response.status === 409) return { inserted: false, runId: null };
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`PostgREST POST strategy_execution_runs returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
      }
      const rows = text ? JSON.parse(text) : [];
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { inserted: true, runId: row?.id ?? null };
    },

    async finishRun(runId: string, status: RunStatus, outcome: { ordId: string | null; algoId: string | null; reason: string | null; detail: string | null }): Promise<void> {
      await request("PATCH", `/rest/v1/strategy_execution_runs?id=eq.${runId}`, {
        status,
        ord_id: outcome.ordId,
        algo_id: outcome.algoId,
        reason: outcome.reason,
        detail: outcome.detail,
        updated_at: new Date().toISOString(),
      });
    },

    async markBindingExecuted(bindingId: string, executedAtMs: number): Promise<void> {
      await request("PATCH", `/rest/v1/strategy_executions?id=eq.${bindingId}`, {
        last_executed_at: new Date(executedAtMs).toISOString(),
        updated_at: new Date().toISOString(),
      });
    },

    async queueReceipt(subscriptionId: string, eventKey: string, payload: Record<string, unknown>): Promise<void> {
      await request("POST", "/rest/v1/telegram_deliveries", {
        subscription_id: subscriptionId,
        event_type: "alert",
        event_key: eventKey,
        payload,
      });
    },
  };
}
