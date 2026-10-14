import type { PositionMode } from "./core/position.ts";
import type { SubscriptionStore } from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

const LIST_COLUMNS = [
  "id",
  "mode",
  "inst_id",
  "pos_side",
  "direction",
  "td_mode",
  "lever",
  "entry_px",
  "sl_px",
  "tp_px",
  "mid_px",
  "theme",
  "theme_stop_cap_u",
  "atr_len",
  "atr_mult",
  "amend_min_atr_frac",
  "half_reduce_frac",
  "dynamic_tp_enabled",
  "half_reduce_enabled",
  "half_reduce_done",
  "half_reduce_attempts",
  "enabled",
  "note",
  "last_note",
  "last_eval_at",
  "last_amend_at",
  "last_reduce_at",
  "updated_at",
].join(",");

/**
 * PostgREST-backed store. Writes go through hive_position_subscription_upsert, so the in-place update, the preserved
 * half_reduce_done and the disable path all live in one statement. Reads use the service role on the enabled rows.
 */
export function createRestSubscriptionStore(options: RestStoreOptions): SubscriptionStore {
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

  return {
    async upsert(row: Record<string, unknown>): Promise<string | null> {
      const id = await request("POST", "/rest/v1/rpc/hive_position_subscription_upsert", { p_row: row });
      return typeof id === "string" ? id : null;
    },

    async list(mode: PositionMode): Promise<Record<string, unknown>[]> {
      const query = new URLSearchParams({
        select: LIST_COLUMNS,
        mode: `eq.${mode}`,
        enabled: "eq.true",
        order: "inst_id.asc",
      });
      return (await request("GET", `/rest/v1/position_subscriptions?${query.toString()}`)) as Record<string, unknown>[];
    },
  };
}
