import type { PositionMode, PositionSubscription } from "./core/position.ts";
import type { EvalPatch, PositionStore } from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface SubscriptionDbRow {
  id: string;
  mode: PositionMode;
  inst_id: string;
  pos_side: PositionSubscription["posSide"];
  direction: PositionSubscription["direction"];
  td_mode: PositionSubscription["tdMode"];
  entry_px: number | string;
  sl_px: number | string;
  tp_px: number | string;
  mid_px: number | string;
  theme_stop_cap_u: number | string;
  atr_len: number | string;
  atr_mult: number | string;
  amend_min_atr_frac: number | string;
  half_reduce_frac: number | string;
  dynamic_tp_enabled: boolean;
  half_reduce_enabled: boolean;
  half_reduce_done: boolean;
  half_reduce_attempts: number | string;
}

function toSubscription(row: SubscriptionDbRow): PositionSubscription {
  return {
    id: row.id,
    mode: row.mode,
    instId: row.inst_id,
    posSide: row.pos_side,
    direction: row.direction,
    tdMode: row.td_mode,
    entryPx: Number(row.entry_px),
    slPx: Number(row.sl_px),
    tpPx: Number(row.tp_px),
    midPx: Number(row.mid_px),
    themeStopCapU: Number(row.theme_stop_cap_u),
    atrLen: Number(row.atr_len),
    atrMult: Number(row.atr_mult),
    amendMinAtrFrac: Number(row.amend_min_atr_frac),
    halfReduceFrac: Number(row.half_reduce_frac),
    dynamicTpEnabled: row.dynamic_tp_enabled,
    halfReduceEnabled: row.half_reduce_enabled,
    halfReduceDone: row.half_reduce_done,
    halfReduceAttempts: Number(row.half_reduce_attempts),
  };
}

function evalColumns(patch: EvalPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = { last_eval_at: patch.lastEvalAt, last_note: patch.lastNote };
  if (patch.lastAmendAt !== undefined) columns.last_amend_at = patch.lastAmendAt;
  if (patch.tpPx !== undefined) columns.tp_px = patch.tpPx;
  return columns;
}

/**
 * PostgREST-backed store. Reads and the eval record use the service role on position_subscriptions. The half-way
 * reduce lease goes through security-definer RPCs, so only one run can hold it.
 */
export function createRestPositionStore(options: RestStoreOptions): PositionStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, preferMinimal = false): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (preferMinimal) headers.prefer = "return=minimal";

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

    async listEnabledSubscriptions(mode: PositionMode): Promise<PositionSubscription[]> {
      const query = new URLSearchParams({
        select: "*",
        mode: `eq.${mode}`,
        enabled: "eq.true",
        order: "created_at.asc",
      });
      const rows = (await request("GET", `/rest/v1/position_subscriptions?${query.toString()}`)) as SubscriptionDbRow[];
      return rows.map(toSubscription);
    },

    async recordEval(id: string, patch: EvalPatch): Promise<void> {
      const query = new URLSearchParams({ id: `eq.${id}` });
      await request("PATCH", `/rest/v1/position_subscriptions?${query.toString()}`, evalColumns(patch), true);
    },

    async claimHalfReduce(id: string, leaseSeconds: number): Promise<boolean> {
      return (await request("POST", "/rest/v1/rpc/hive_position_claim_half_reduce", {
        p_id: id,
        p_lease_seconds: leaseSeconds,
      })) === true;
    },

    async finishHalfReduce(id: string, outcome: { done: boolean; note: string; reduced: boolean }): Promise<void> {
      await request("POST", "/rest/v1/rpc/hive_position_finish_half_reduce", {
        p_id: id,
        p_done: outcome.done,
        p_note: outcome.note,
        p_reduced: outcome.reduced,
      });
    },
  };
}
