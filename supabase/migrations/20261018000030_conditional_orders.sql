-- Conditional orders: resting instructions that strategy-evaluator (cron, every 3 minutes) turns into a
-- real open through order-submit when a strategy template's two-stage condition fires. Stage one (setup)
-- primes the order when the market has done the damage the template waits for; stage two (trigger) is the
-- reversal confirmation that actually buys. The first template is reversal_long: capitulation-then-reversal
-- entries anchored to the setup low for the stop. Additive: one table, one claim RPC, one cron job.
-- Nothing existing changes.

-- 1) Orders. One row per instruction; status walks armed -> primed -> fired, with expired/cancelled/failed
--    as terminal exits. A primed setup that breaks down returns to armed (invalidations counts those), so a
--    deeper capitulation can prime the same order again inside its expiry window. params is the template's
--    JSON, validated by @hive/core parseStrategyParams at creation and again at every evaluation.
create table public.conditional_orders (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('demo', 'live')),
  inst_id text not null check (inst_id ~ '^[A-Z0-9]+-USDT-SWAP$'),
  symbol text not null,
  template text not null check (template in ('reversal_long')),
  direction text not null default 'long' check (direction in ('long')),
  pos_side text not null default 'net' check (pos_side in ('net', 'long', 'short')),
  td_mode text not null default 'isolated' check (td_mode in ('isolated', 'cross')),
  lever numeric not null check (lever >= 1 and lever <= 125),
  sz numeric not null check (sz > 0),
  theme text not null,
  theme_stop_cap_u numeric not null check (theme_stop_cap_u > 0 and theme_stop_cap_u <= 0.1),
  tp_pct numeric check (tp_pct is null or (tp_pct > 0 and tp_pct <= 200)),
  params jsonb not null default '{}'::jsonb,
  status text not null default 'armed'
    check (status in ('armed', 'primed', 'fired', 'expired', 'cancelled', 'failed')),
  setup_low numeric,
  setup_low_ts timestamptz,
  setup_at timestamptz,
  ref_high numeric,
  drawdown_pct numeric,
  invalidations integer not null default 0,
  claimed_at timestamptz,
  fire_bar_ts timestamptz,
  fire_trigger text,
  fired_at timestamptz,
  ord_id text,
  algo_id text,
  last_eval_at timestamptz,
  last_note text,
  expires_at timestamptz not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conditional_orders_active_idx
  on public.conditional_orders (mode, status)
  where status in ('armed', 'primed');

-- 2) Service-role only, like the other order tables. The web API and the evaluator both use the service role.
alter table public.conditional_orders enable row level security;
create policy service_role_all on public.conditional_orders for all to service_role using (true) with check (true);
revoke all on public.conditional_orders from anon, authenticated;
grant select, insert, update on public.conditional_orders to service_role;

-- The evaluator records fires and risk rejections as critical alerts so push-notify and the webhook fan-out
-- carry them; alert inserts via PostgREST need the grant explicitly.
grant insert on public.alerts to service_role;

-- 3) Fire lease. Only one evaluator run may submit for an order. The lease expires, so a crashed run cannot
--    block the order forever. The submit itself is also idempotent (deterministic key per trigger bar), so
--    the lease is belt-and-braces rather than the only guard.
create or replace function public.hive_conditional_claim(p_id uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.conditional_orders
     set claimed_at = now()
   where id = p_id
     and status in ('armed', 'primed')
     and (claimed_at is null or claimed_at < now() - make_interval(secs => p_lease_seconds));
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;

revoke execute on function public.hive_conditional_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.hive_conditional_claim(uuid, integer) to service_role;

-- 4) Schedule. Every 3 minutes, like position-manager. An empty table is a cheap no-op.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-strategy-evaluator') then
    perform cron.unschedule('hive-strategy-evaluator');
  end if;
end
$$;

select cron.schedule('hive-strategy-evaluator', '*/3 * * * *', $$select public.hive_invoke_edge_function('strategy-evaluator')$$);
