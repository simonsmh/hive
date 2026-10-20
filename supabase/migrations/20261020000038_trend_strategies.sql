-- Trend strategies (trend_follow): hosted trend-following instances that trend-evaluator (cron, every
-- 3 minutes) evaluates against confirmed 5m bars with the pure functions in @hive/core (trend.ts). An armed
-- instance waits for the composed mechanical trigger (ATR expansion + fat trigger bar + Donchian breakout
-- + volume + peer confirmation + trend regime); an active instance pyramids in ATR steps under one unified
-- stop whose worst-case loss never exceeds the theme cap, and exits on ATR decay or an adverse MA close.
-- run_mode separates simulation from trading: shadow instances run the full state machine against live bars
-- and write events, but never submit an order; live instances submit through order-submit, so every risk
-- gate still applies. Every state transition, trigger, skip and reconcile writes a structured row to
-- trend_strategy_events. Additive: two tables, one claim RPC, one cron job. Nothing existing changes.

-- 1) Instances. One row per instruction; status walks armed -> active -> done, with expired/cancelled/
--    failed as terminal exits. params is the template JSON validated by @hive/core parseTrendParams at
--    creation and again at every evaluation; state is the evaluator's runtime memory (entry, peak ATR,
--    unified stop, add count, last consumed bar), round-tripped through parseTrendState.
create table public.trend_strategies (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('demo', 'live')),
  run_mode text not null default 'shadow' check (run_mode in ('shadow', 'live')),
  inst_id text not null check (inst_id ~ '^[A-Z0-9]+-USDT-SWAP$'),
  symbol text not null,
  direction text not null check (direction in ('long', 'short')),
  pos_side text not null default 'net' check (pos_side in ('net', 'long', 'short')),
  td_mode text not null default 'isolated' check (td_mode in ('isolated', 'cross')),
  lever numeric not null check (lever >= 1 and lever <= 125),
  first_sz numeric not null check (first_sz > 0),
  theme text not null,
  theme_stop_cap_u numeric not null check (theme_stop_cap_u > 0 and theme_stop_cap_u <= 0.1),
  params jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  status text not null default 'armed'
    check (status in ('armed', 'active', 'done', 'expired', 'cancelled', 'failed')),
  claimed_at timestamptz,
  last_eval_at timestamptz,
  last_note text,
  expires_at timestamptz not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index trend_strategies_active_idx
  on public.trend_strategies (mode, status)
  where status in ('armed', 'active');

-- 2) Events: append-only observability. kind is a short machine string (trigger_fired, opened, add_planned,
--    exit_triggered, reconcile_planned, eval_skip, ...); detail carries the numbers behind the decision.
create table public.trend_strategy_events (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.trend_strategies (id) on delete cascade,
  ts timestamptz not null default now(),
  kind text not null,
  detail jsonb not null default '{}'::jsonb
);

create index trend_strategy_events_instance_idx
  on public.trend_strategy_events (instance_id, ts desc);

-- 3) Service-role only, like the other order tables. The web API and the evaluator both use the service
--    role. Grants are explicit: from 2026-10-30 new public tables no longer receive Data API grants
--    automatically, so every grant the code relies on is written out here.
alter table public.trend_strategies enable row level security;
create policy service_role_all on public.trend_strategies for all to service_role using (true) with check (true);
revoke all on public.trend_strategies from anon, authenticated;
grant select, insert, update on public.trend_strategies to service_role;

alter table public.trend_strategy_events enable row level security;
create policy service_role_all on public.trend_strategy_events for all to service_role using (true) with check (true);
revoke all on public.trend_strategy_events from anon, authenticated;
grant select, insert on public.trend_strategy_events to service_role;

-- 4) Action lease. Only one evaluator run may act for an instance at a time. The lease expires, so a
--    crashed run cannot block the instance forever. Submits are also idempotent (deterministic keys per
--    trigger bar / add index), so the lease is belt-and-braces rather than the only guard.
create or replace function public.hive_trend_claim(p_id uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.trend_strategies
     set claimed_at = now()
   where id = p_id
     and status in ('armed', 'active')
     and (claimed_at is null or claimed_at < now() - make_interval(secs => p_lease_seconds));
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;

revoke execute on function public.hive_trend_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.hive_trend_claim(uuid, integer) to service_role;

-- 5) Schedule. Every 3 minutes, like the other evaluators: decisions are per confirmed 5m bar and a
--    run that finds no new bar is a no-op that writes nothing, so a 3-minute cadence costs at most ~2
--    minutes of entry/exit latency after a bar confirms. Every minute would add ~43k invocations a
--    month and push the project over the free Edge quota (see README 免费额度）; with no armed/active
--    instances the function exits after one indexed query.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-trend-evaluator') then
    perform cron.unschedule('hive-trend-evaluator');
  end if;
end
$$;

select cron.schedule('hive-trend-evaluator', '*/3 * * * *', $$select public.hive_invoke_edge_function('trend-evaluator')$$);
