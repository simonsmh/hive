-- P0c: in-position management on Edge. position-manager (cron, every 3 minutes) moves the take-profit to the
-- dynamic ATR level and reduces ~50% once when a confirmed 5m close fails the half-way level. Each open position
-- is one row here. Any USDT swap can be subscribed; there is no symbol allowlist for this feature.
-- Additive: one new table, RPCs, a live risk_limits row and a cron job. Nothing existing changes.

-- 1) Subscriptions. One enabled row per (mode, inst_id, pos_side). pos_side is OKX's posSide (net in net mode).
--    direction is the side of the position and is always set, which net mode needs. Levels follow the field lock:
--    mid_px = (entry + SL) / 2, locked at open. Stop-related columns sit on the side that matches direction.
create table public.position_subscriptions (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('demo', 'live')),
  inst_id text not null check (inst_id ~ '^[A-Z0-9]+-USDT-SWAP$'),
  pos_side text not null check (pos_side in ('net', 'long', 'short')),
  direction text not null check (direction in ('long', 'short')),
  check (pos_side = 'net' or pos_side = direction),
  td_mode text not null default 'isolated' check (td_mode in ('isolated', 'cross')),
  lever numeric not null check (lever >= 1 and lever <= 125),
  entry_px numeric not null check (entry_px > 0),
  sl_px numeric not null check (sl_px > 0),
  tp_px numeric not null check (tp_px > 0),
  mid_px numeric not null check (mid_px > 0),
  check (mid_px between least(entry_px, sl_px) and greatest(entry_px, sl_px)),
  check (
    (direction = 'long' and sl_px <= entry_px and tp_px > entry_px)
    or (direction = 'short' and sl_px >= entry_px and tp_px < entry_px)
  ),
  theme text,
  theme_stop_cap_u numeric not null check (theme_stop_cap_u > 0 and theme_stop_cap_u <= 0.1),
  atr_tf text not null default '1H' check (atr_tf = '1H'),
  atr_len integer not null default 14 check (atr_len between 2 and 100),
  atr_mult numeric not null default 0.8 check (atr_mult > 0 and atr_mult <= 5),
  amend_min_atr_frac numeric not null default 0.15 check (amend_min_atr_frac > 0 and amend_min_atr_frac <= 5),
  half_reduce_frac numeric not null default 0.5 check (half_reduce_frac > 0 and half_reduce_frac < 1),
  dynamic_tp_enabled boolean not null default true,
  half_reduce_enabled boolean not null default true,
  half_reduce_done boolean not null default false,
  half_reduce_claimed_at timestamptz,
  -- Counts reduce attempts that placed nothing. It goes into the reduce idempotency key, so a rejected attempt can be
  -- retried after order-submit's 10-minute key window has passed. Never reset.
  half_reduce_attempts integer not null default 0,
  enabled boolean not null default true,
  note text,
  last_note text,
  last_eval_at timestamptz,
  last_amend_at timestamptz,
  last_reduce_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index position_subscriptions_one_enabled
  on public.position_subscriptions (mode, inst_id, pos_side) where enabled;

-- 2) Service-role only, like the other order tables.
alter table public.position_subscriptions enable row level security;
create policy service_role_all on public.position_subscriptions for all to service_role using (true) with check (true);
revoke all on public.position_subscriptions from anon, authenticated;
grant select, insert, update on public.position_subscriptions to service_role;

-- 3) Upsert. Called by position-subscriptions (HIVE_ORDER_TOKEN) and by the post-deploy seed. An enabled row with the
--    same (mode, inst_id, pos_side) is updated in place. half_reduce_done is preserved on every update, so a re-run
--    never allows a second reduce. Only reset_state=true clears it, for a genuinely new position.
--    enabled=false disables the existing enabled row and returns its id, or null when there is none.
create or replace function public.hive_position_subscription_upsert(p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_reset boolean := coalesce((p_row->>'reset_state')::boolean, false);
begin
  if not coalesce((p_row->>'enabled')::boolean, true) then
    update public.position_subscriptions
       set enabled = false, updated_at = now()
     where mode = p_row->>'mode' and inst_id = p_row->>'inst_id' and pos_side = p_row->>'pos_side' and enabled
    returning id into v_id;
    return v_id;
  end if;

  insert into public.position_subscriptions as s (
    mode, inst_id, pos_side, direction, td_mode, lever, entry_px, sl_px, tp_px, mid_px,
    theme, theme_stop_cap_u, atr_len, atr_mult, amend_min_atr_frac, half_reduce_frac,
    dynamic_tp_enabled, half_reduce_enabled, enabled, note
  ) values (
    p_row->>'mode', p_row->>'inst_id', p_row->>'pos_side', p_row->>'direction', p_row->>'td_mode',
    (p_row->>'lever')::numeric, (p_row->>'entry_px')::numeric, (p_row->>'sl_px')::numeric,
    (p_row->>'tp_px')::numeric, (p_row->>'mid_px')::numeric, p_row->>'theme', (p_row->>'theme_stop_cap_u')::numeric,
    (p_row->>'atr_len')::integer, (p_row->>'atr_mult')::numeric, (p_row->>'amend_min_atr_frac')::numeric,
    (p_row->>'half_reduce_frac')::numeric, (p_row->>'dynamic_tp_enabled')::boolean,
    (p_row->>'half_reduce_enabled')::boolean, true, p_row->>'note'
  )
  on conflict (mode, inst_id, pos_side) where enabled
  do update set
    direction = excluded.direction,
    td_mode = excluded.td_mode,
    lever = excluded.lever,
    entry_px = excluded.entry_px,
    sl_px = excluded.sl_px,
    tp_px = excluded.tp_px,
    mid_px = excluded.mid_px,
    theme = excluded.theme,
    theme_stop_cap_u = excluded.theme_stop_cap_u,
    atr_len = excluded.atr_len,
    atr_mult = excluded.atr_mult,
    amend_min_atr_frac = excluded.amend_min_atr_frac,
    half_reduce_frac = excluded.half_reduce_frac,
    dynamic_tp_enabled = excluded.dynamic_tp_enabled,
    half_reduce_enabled = excluded.half_reduce_enabled,
    note = coalesce(excluded.note, s.note),
    half_reduce_done = case when v_reset then false else s.half_reduce_done end,
    half_reduce_claimed_at = case when v_reset then null else s.half_reduce_claimed_at end,
    last_reduce_at = case when v_reset then null else s.last_reduce_at end,
    last_amend_at = case when v_reset then null else s.last_amend_at end,
    updated_at = now()
  returning id into v_id;

  return v_id;
end
$$;

-- 4) Half-way reduce lease. Only one run may place the reduce for a subscription. The lease expires, so a crashed run
--    cannot block the subscription forever. Returns true when this caller holds the lease.
create or replace function public.hive_position_claim_half_reduce(p_id uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.position_subscriptions
     set half_reduce_claimed_at = now()
   where id = p_id
     and enabled
     and not half_reduce_done
     and (half_reduce_claimed_at is null or half_reduce_claimed_at < now() - make_interval(secs => p_lease_seconds));
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;

-- 5) Finish the reduce attempt. p_done=true closes it for good (acked, or the outcome is unknown and must be checked on
--    OKX). p_done=false releases it because nothing was placed, so the next run may try again.
create or replace function public.hive_position_finish_half_reduce(
  p_id uuid,
  p_done boolean,
  p_note text,
  p_reduced boolean
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.position_subscriptions
     set half_reduce_done = p_done,
         half_reduce_claimed_at = null,
         half_reduce_attempts = half_reduce_attempts + case when p_done then 0 else 1 end,
         last_note = left(p_note, 500),
         last_reduce_at = case when p_reduced then now() else last_reduce_at end,
         updated_at = now()
   where id = p_id;
$$;

revoke execute on function public.hive_position_subscription_upsert(jsonb) from public, anon, authenticated;
revoke execute on function public.hive_position_claim_half_reduce(uuid, integer) from public, anon, authenticated;
revoke execute on function public.hive_position_finish_half_reduce(uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.hive_position_subscription_upsert(jsonb) to service_role;
grant execute on function public.hive_position_claim_half_reduce(uuid, integer) to service_role;
grant execute on function public.hive_position_finish_half_reduce(uuid, boolean, text, boolean) to service_role;

-- 6) Live risk limits. order-submit fails closed without an enabled row for the mode, so this row lets in-position
--    actions run live. Its allowlist is empty on purpose: live opens are refused until someone adds instruments.
--    amend_tpsl and reduce are not gated by the allowlist when the instrument has an enabled subscription row.
--    Disable with: update public.risk_limits set enabled = false where name = 'live-default';
insert into public.risk_limits (name, mode, symbol_allowlist, max_notional_usdt, max_leverage, max_orders_per_min)
select 'live-default', 'live', '{}'::text[], 500, 15, 10
 where not exists (select 1 from public.risk_limits where mode = 'live' and enabled);

-- 7) Schedule. Every 3 minutes, as agreed. The function reads subscriptions, so an empty table is a cheap no-op.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-position-manager') then
    perform cron.unschedule('hive-position-manager');
  end if;
end
$$;

select cron.schedule('hive-position-manager', '*/3 * * * *', $$select public.hive_invoke_edge_function('position-manager')$$);
