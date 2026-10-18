import "server-only";
import type { ConditionalOrderInput } from "@hive/core";
import { assertNoError, getDb } from "@/lib/supabase";
import { toConditionalOrderView, type ConditionalOrderRow, type ConditionalOrderView } from "./mapper";

const ORDER_COLUMNS =
  "id, mode, inst_id, symbol, template, direction, pos_side, td_mode, lever, sz, theme, theme_stop_cap_u, tp_pct, params, status, setup_low, setup_low_ts, ref_high, drawdown_pct, invalidations, fire_bar_ts, fire_trigger, fired_at, ord_id, last_eval_at, last_note, expires_at, note, created_at";

/** Most recent 100 orders, newest first; the panel groups them by status client-side. */
export async function listOrderViews(): Promise<ConditionalOrderView[]> {
  const { data, error } = await getDb()
    .from("conditional_orders")
    .select(ORDER_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(100);
  assertNoError(error);
  return ((data ?? []) as ConditionalOrderRow[]).map(toConditionalOrderView);
}

/** Inserts a validated conditional order in `armed` state. The evaluator picks it up within 3 minutes. */
export async function createOrder(input: ConditionalOrderInput): Promise<ConditionalOrderView> {
  const symbol = input.instId.split("-")[0]!;
  const { data, error } = await getDb()
    .from("conditional_orders")
    .insert({
      mode: input.mode,
      inst_id: input.instId,
      symbol,
      template: input.template,
      direction: "long",
      pos_side: "net",
      td_mode: input.tdMode,
      lever: input.lever,
      sz: input.sz,
      theme: input.theme,
      theme_stop_cap_u: input.themeStopCapU,
      tp_pct: input.tpPct,
      params: input.params,
      status: "armed",
      expires_at: input.expiresAt,
      note: input.note,
    })
    .select(ORDER_COLUMNS)
    .single();
  assertNoError(error);
  return toConditionalOrderView(data as ConditionalOrderRow);
}

/** Cancels an order that has not fired yet. Returns the updated view, or null when it was no longer cancellable. */
export async function cancelOrder(id: string): Promise<ConditionalOrderView | null> {
  const { data, error } = await getDb()
    .from("conditional_orders")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["armed", "primed"])
    .select(ORDER_COLUMNS);
  assertNoError(error);
  const rows = (data ?? []) as ConditionalOrderRow[];
  return rows.length > 0 ? toConditionalOrderView(rows[0]!) : null;
}
