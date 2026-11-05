-- Strategy executor: rule -> order-intent bindings.
--
-- A binding turns an alert-rule trigger into an OKX order through the
-- existing order-submit path (kill switch, risk limits, idempotency all
-- still apply there). The executor only submits; it never invents an
-- order: every intent field comes from the binding row, which is created
-- with user-specified parameters.
--
-- Safety defaults, all fail-closed:
--   * bindings are disabled by default: nothing executes until a binding
--     is explicitly enabled with concrete parameters.
--   * one run per (binding, alert): the unique guard makes replays and
--     overlapping executor runs unable to double-submit.
--   * stale alerts (> 15 minutes) are skipped, never backfilled: an
--     executor outage or a kill-switch pause cannot release a burst of
--     old triggers later.
--   * a binding cooldown is consumed on claim, so a rejected submit does
--     not retry every poll cycle.

create table if not exists public.strategy_executions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[a-z0-9_-]{1,64}$'),
  rule_id uuid not null references public.alert_rules (id) on delete cascade,
  action text not null check (action in ('open', 'close', 'reduce', 'amend_tpsl', 'set_leverage', 'adjust_margin')),
  inst_id text not null check (inst_id ~ '^[A-Z0-9]+-USDT-SWAP$'),
  side text not null check (side in ('buy', 'sell')),
  pos_side text not null default 'net' check (pos_side in ('net', 'long', 'short')),
  td_mode text not null default 'isolated' check (td_mode in ('isolated', 'cross')),
  lever numeric null check (lever is null or lever > 0),
  sz text not null check (sz ~ '^[0-9]+(\.[0-9]+)?$'),
  ord_type text not null default 'market' check (ord_type in ('market', 'limit')),
  px text null check (px is null or px ~ '^[0-9]+(\.[0-9]+)?$'),
  reduce_only boolean not null default false,
  sl_trigger_px text null,
  sl_ord_px text null,
  tp_trigger_px text null,
  tp_ord_px text null,
  theme text null,
  theme_stop_cap_u numeric null check (theme_stop_cap_u is null or theme_stop_cap_u > 0),
  max_loss_u numeric null check (max_loss_u is null or max_loss_u > 0),
  margin_amt text null,
  reason text null,
  cooldown_seconds integer not null default 3600 check (cooldown_seconds > 0),
  notify_subscription_id uuid null references public.telegram_subscriptions (id) on delete set null,
  enabled boolean not null default false,
  last_executed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Mirror order-submit's intent validation so a bad binding fails at
  -- insert time instead of at fire time.
  check (ord_type <> 'limit' or px is not null),
  check ((sl_trigger_px is null) = (sl_ord_px is null)),
  check ((tp_trigger_px is null) = (tp_ord_px is null)),
  check (action <> 'open' or (lever is not null and theme is not null and sl_trigger_px is not null and sl_ord_px is not null and theme_stop_cap_u is not null)),
  check (action <> 'open' or not reduce_only),
  check (action not in ('close', 'reduce') or reduce_only),
  check (action <> 'amend_tpsl' or (sl_trigger_px is not null or tp_trigger_px is not null)),
  check (action <> 'set_leverage' or (lever is not null and px is null and sl_trigger_px is null and tp_trigger_px is null and not reduce_only)),
  check (action <> 'adjust_margin' or (margin_amt is not null and td_mode = 'isolated' and lever is null and px is null and sl_trigger_px is null and tp_trigger_px is null and not reduce_only)),
  check (action = 'adjust_margin' or margin_amt is null)
);
create index if not exists strategy_executions_rule_idx on public.strategy_executions (rule_id) where enabled;

create table if not exists public.strategy_execution_runs (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.strategy_executions (id) on delete cascade,
  alert_id bigint not null references public.alerts (id) on delete cascade,
  intent_id text null,
  idempotency_key text not null,
  status text not null check (status in ('processing', 'acked', 'rejected', 'failed', 'skipped_stale', 'skipped_cooldown', 'skipped_live_disabled')),
  ord_id text null,
  algo_id text null,
  reason text null,
  detail text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (binding_id, alert_id)
);
create index if not exists strategy_execution_runs_binding_idx on public.strategy_execution_runs (binding_id, created_at desc);
create index if not exists strategy_execution_runs_alert_idx on public.strategy_execution_runs (alert_id);

select cron.schedule('hive-strategy-executor', '30 seconds', $$select public.hive_invoke_edge_function('strategy-executor')$$);
