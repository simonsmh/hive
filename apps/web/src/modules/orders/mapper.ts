/** Row shape of public.conditional_orders as selected by the API. */
export interface ConditionalOrderRow {
  id: string;
  mode: string;
  inst_id: string;
  symbol: string;
  template: string;
  direction: string;
  pos_side: string;
  td_mode: string;
  lever: number | string;
  sz: number | string;
  theme: string;
  theme_stop_cap_u: number | string;
  tp_pct: number | string | null;
  params: Record<string, unknown>;
  status: string;
  setup_low: number | string | null;
  setup_low_ts: string | null;
  ref_high: number | string | null;
  drawdown_pct: number | string | null;
  invalidations: number;
  fire_bar_ts: string | null;
  fire_trigger: string | null;
  fired_at: string | null;
  ord_id: string | null;
  last_eval_at: string | null;
  last_note: string | null;
  expires_at: string;
  note: string | null;
  created_at: string;
}

export interface ConditionalOrderView {
  id: string;
  mode: string;
  inst_id: string;
  symbol: string;
  template: string;
  lever: number;
  sz: string;
  td_mode: string;
  theme: string;
  theme_stop_cap_u: number;
  tp_pct: number | null;
  params: Record<string, unknown>;
  status: string;
  setup_low: number | null;
  setup_low_ts: string | null;
  ref_high: number | null;
  drawdown_pct: number | null;
  invalidations: number;
  fire_trigger: string | null;
  fired_at: string | null;
  ord_id: string | null;
  last_eval_at: string | null;
  last_note: string | null;
  expires_at: string;
  note: string | null;
  created_at: string;
}

const num = (value: number | string | null): number | null => (value === null ? null : Number(value));

export function toConditionalOrderView(row: ConditionalOrderRow): ConditionalOrderView {
  return {
    id: row.id,
    mode: row.mode,
    inst_id: row.inst_id,
    symbol: row.symbol,
    template: row.template,
    lever: Number(row.lever),
    sz: String(row.sz),
    td_mode: row.td_mode,
    theme: row.theme,
    theme_stop_cap_u: Number(row.theme_stop_cap_u),
    tp_pct: num(row.tp_pct),
    params: row.params ?? {},
    status: row.status,
    setup_low: num(row.setup_low),
    setup_low_ts: row.setup_low_ts,
    ref_high: num(row.ref_high),
    drawdown_pct: num(row.drawdown_pct),
    invalidations: Number(row.invalidations),
    fire_trigger: row.fire_trigger,
    fired_at: row.fired_at,
    ord_id: row.ord_id,
    last_eval_at: row.last_eval_at,
    last_note: row.last_note,
    expires_at: row.expires_at,
    note: row.note,
    created_at: row.created_at,
  };
}
