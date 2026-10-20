/** Row shape of public.trend_strategies as selected by the API. */
export interface TrendStrategyRow {
  id: string;
  mode: string;
  run_mode: string;
  inst_id: string;
  symbol: string;
  direction: string;
  pos_side: string;
  td_mode: string;
  lever: number | string;
  first_sz: number | string;
  theme: string;
  theme_stop_cap_u: number | string;
  params: Record<string, unknown>;
  state: Record<string, unknown>;
  status: string;
  last_eval_at: string | null;
  last_note: string | null;
  expires_at: string;
  note: string | null;
  created_at: string;
}

/** Row shape of public.trend_strategy_events as selected by the API. */
export interface TrendEventRow {
  id: string;
  instance_id: string;
  ts: string;
  kind: string;
  detail: Record<string, unknown>;
}

export interface TrendEventView {
  ts: string;
  kind: string;
  detail: Record<string, unknown>;
}

export interface TrendStrategyView {
  id: string;
  mode: string;
  run_mode: string;
  inst_id: string;
  symbol: string;
  direction: string;
  td_mode: string;
  lever: number;
  first_sz: string;
  theme: string;
  theme_stop_cap_u: number;
  params: Record<string, unknown>;
  status: string;
  /** Runtime state summary lifted out of the state jsonb for the panel. */
  entry_px: number | null;
  peak_atr: number | null;
  stop_px: number | null;
  position_sz: number;
  adds: number;
  exit_reason: string | null;
  last_eval_at: string | null;
  last_note: string | null;
  expires_at: string;
  note: string | null;
  created_at: string;
  recent_events: TrendEventView[];
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function toTrendStrategyView(row: TrendStrategyRow, events: TrendEventRow[] = []): TrendStrategyView {
  const state = row.state ?? {};
  const positionSz = num(state.positionSz);
  const adds = num(state.adds);
  return {
    id: row.id,
    mode: row.mode,
    run_mode: row.run_mode,
    inst_id: row.inst_id,
    symbol: row.symbol,
    direction: row.direction,
    td_mode: row.td_mode,
    lever: Number(row.lever),
    first_sz: String(row.first_sz),
    theme: row.theme,
    theme_stop_cap_u: Number(row.theme_stop_cap_u),
    params: row.params ?? {},
    status: row.status,
    entry_px: num(state.entryPx),
    peak_atr: num(state.peakAtr),
    stop_px: num(state.stopPx),
    position_sz: positionSz ?? 0,
    adds: adds !== null && Number.isInteger(adds) ? adds : 0,
    exit_reason: typeof state.exitReason === "string" ? state.exitReason : null,
    last_eval_at: row.last_eval_at,
    last_note: row.last_note,
    expires_at: row.expires_at,
    note: row.note,
    created_at: row.created_at,
    recent_events: events
      .filter((event) => event.instance_id === row.id)
      .map((event) => ({ ts: event.ts, kind: event.kind, detail: event.detail ?? {} })),
  };
}
