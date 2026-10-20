import "server-only";
import type { TrendStrategyInput } from "@hive/core";
import { assertNoError, getDb } from "@/lib/supabase";
import { toTrendStrategyView, type TrendEventRow, type TrendStrategyRow, type TrendStrategyView } from "./mapper";

const STRATEGY_COLUMNS =
  "id, mode, run_mode, inst_id, symbol, direction, pos_side, td_mode, lever, first_sz, theme, theme_stop_cap_u, params, state, status, last_eval_at, last_note, expires_at, note, created_at";
const EVENTS_PER_INSTANCE = 8;

/** Most recent 100 instances, newest first, each with its latest events for the panel timeline. */
export async function listTrendViews(): Promise<TrendStrategyView[]> {
  const db = getDb();
  const { data, error } = await db
    .from("trend_strategies")
    .select(STRATEGY_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(100);
  assertNoError(error);
  const rows = (data ?? []) as TrendStrategyRow[];
  if (rows.length === 0) return [];

  // Latest events are fetched per instance (the (instance_id, ts) index serves each
  // lookup): a single query with a global limit ordered by recency lets one busy
  // strategy's snapshots consume the whole budget and starve every other timeline.
  const eventLists = await Promise.all(
    rows.map(async (row) => {
      const { data, error } = await db
        .from("trend_strategy_events")
        .select("id, instance_id, ts, kind, detail")
        .eq("instance_id", row.id)
        .order("ts", { ascending: false })
        .limit(EVENTS_PER_INSTANCE);
      assertNoError(error);
      return (data ?? []) as TrendEventRow[];
    }),
  );
  const events = eventLists.flat();
  return rows.map((row) => toTrendStrategyView(row, events));
}

/** Inserts a validated trend strategy in `armed` state. The evaluator picks it up within 3 minutes. */
export async function createTrendStrategy(input: TrendStrategyInput): Promise<TrendStrategyView> {
  const symbol = input.instId.split("-")[0]!;
  const { data, error } = await getDb()
    .from("trend_strategies")
    .insert({
      mode: input.mode,
      run_mode: input.runMode,
      inst_id: input.instId,
      symbol,
      direction: input.direction,
      pos_side: "net",
      td_mode: input.tdMode,
      lever: input.lever,
      first_sz: input.firstSz,
      theme: input.theme,
      theme_stop_cap_u: input.themeStopCapU,
      params: input.params,
      status: "armed",
      expires_at: input.expiresAt,
      note: input.note,
    })
    .select(STRATEGY_COLUMNS)
    .single();
  assertNoError(error);
  return toTrendStrategyView(data as TrendStrategyRow);
}

/**
 * Cancels an armed/active instance. Refused while the evaluator holds a fresh action claim
 * (ACTION_LEASE_SEC = 300s in trend-evaluator): a successful cancel must guarantee no submission
 * is in flight. Cancelling an ACTIVE live instance stops management only — the position itself
 * stays open under its exchange-side stop; it is not closed by cancelling.
 */
export async function cancelTrendStrategy(id: string): Promise<TrendStrategyView | null> {
  const claimCutoff = new Date(Date.now() - 300_000).toISOString();
  const { data, error } = await getDb()
    .from("trend_strategies")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["armed", "active"])
    .or(`claimed_at.is.null,claimed_at.lt.${claimCutoff}`)
    .select(STRATEGY_COLUMNS);
  assertNoError(error);
  const rows = (data ?? []) as TrendStrategyRow[];
  return rows.length > 0 ? toTrendStrategyView(rows[0]!) : null;
}
