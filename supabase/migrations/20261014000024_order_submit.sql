-- P0b: intent -> order path for the order-submit Edge Function (okx.intent.v1). Demo first.
-- Adds the global kill switch, per-mode risk limits, the intent log that makes submissions idempotent, and the
-- orders Hive placed on OKX. All four tables are service-role only, like the rest of Hive. Writes go through
-- security-definer RPCs so the idempotency check and the insert are a single statement.
-- Additive: the orders and intents tables are new, and nothing existing changes.

-- 1) Kill switch. One row. While engaged, order-submit refuses every request with 423.
create table public.kill_switch (
  id smallint primary key default 1 check (id = 1),
  engaged boolean not null default false,
  reason text,
  engaged_at timestamptz,
  engaged_by text,
  updated_at timestamptz not null default now()
);
insert into public.kill_switch (id) values (1) on conflict (id) do nothing;

-- 2) Risk limits per trading mode. order-submit reads the one enabled row for its mode and fails closed when there
--    is none. An empty symbol_allowlist rejects every instrument.
create table public.risk_limits (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  mode text not null check (mode in ('demo', 'live')),
  symbol_allowlist text[] not null default '{}',
  max_notional_usdt numeric not null check (max_notional_usdt > 0),
  max_leverage numeric not null check (max_leverage >= 1),
  max_orders_per_min integer not null default 5 check (max_orders_per_min > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index risk_limits_one_enabled_per_mode on public.risk_limits (mode) where enabled;

-- 3) Intent log. intent_id and idempotency_key are both unique. A repeated idempotency_key returns the stored
--    result for 10 minutes (see the handler). cl_ord_id is the OKX clOrdId derived from the key.
--    Column names follow okx.intent.v1 in snake_case (intentId -> intent_id, createdAt -> intent_created_at).
create table public.order_intents (
  id bigint generated always as identity primary key,
  intent_id text not null unique,
  idempotency_key text not null unique,
  mode text not null check (mode in ('demo', 'live')),
  schema_version text not null,
  action text not null check (action in ('open', 'close', 'amend_tpsl', 'reduce')),
  source text not null,
  inst_id text not null,
  side text not null check (side in ('buy', 'sell')),
  pos_side text not null check (pos_side in ('net', 'long', 'short')),
  td_mode text not null check (td_mode in ('isolated', 'cross')),
  lever numeric,
  sz numeric not null check (sz > 0),
  ord_type text not null check (ord_type in ('market', 'limit')),
  px numeric,
  reduce_only boolean not null default false,
  sl_trigger_px numeric,
  sl_ord_px numeric,
  tp_trigger_px numeric,
  tp_ord_px numeric,
  theme text,
  theme_stop_cap_u numeric,
  max_loss_u numeric,
  reason text,
  intent_created_at timestamptz not null,
  ttl_sec integer not null check (ttl_sec between 1 and 3600),
  cl_ord_id text not null unique,
  status text not null default 'received' check (
    status in ('received', 'acked', 'exchange_error', 'rejected_risk', 'rejected_auth', 'expired')
  ),
  reject_reason text,
  ord_id text,
  algo_id text,
  detail text,
  request jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_intents_mode_received_idx on public.order_intents (mode, received_at desc);

-- 4) Orders and algo orders Hive placed. kind = 'order' carries ord_id; kind = 'algo' carries algo_id. state starts at
--    'accepted' (OKX took the request). order-sync (follow-up) moves it to live / filled / canceled.
create table public.orders (
  id bigint generated always as identity primary key,
  exchange text not null default 'okx',
  intent_id text references public.order_intents (intent_id),
  mode text not null check (mode in ('demo', 'live')),
  action text not null check (action in ('open', 'close', 'amend_tpsl', 'reduce')),
  kind text not null check (kind in ('order', 'algo')),
  inst_id text not null,
  side text not null check (side in ('buy', 'sell')),
  pos_side text not null check (pos_side in ('net', 'long', 'short')),
  ord_type text not null,
  ord_id text,
  algo_id text,
  cl_ord_id text not null,
  sz numeric not null,
  px numeric,
  fill_px numeric,
  fill_sz numeric,
  state text not null default 'accepted' check (
    state in ('accepted', 'live', 'partially_filled', 'filled', 'canceled', 'failed')
  ),
  last_sync_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exchange, cl_ord_id),
  check ((kind = 'order' and ord_id is not null) or (kind = 'algo' and algo_id is not null))
);
create unique index orders_ord_id_key on public.orders (exchange, ord_id) where ord_id is not null;
create unique index orders_algo_id_key on public.orders (exchange, algo_id) where algo_id is not null;
create index orders_inst_state_idx on public.orders (inst_id, state);

-- RLS on every table, service_role only. Nothing for anon or authenticated.
alter table public.kill_switch enable row level security;
alter table public.risk_limits enable row level security;
alter table public.order_intents enable row level security;
alter table public.orders enable row level security;

create policy service_role_all on public.kill_switch for all to service_role using (true) with check (true);
create policy service_role_all on public.risk_limits for all to service_role using (true) with check (true);
create policy service_role_all on public.order_intents for all to service_role using (true) with check (true);
create policy service_role_all on public.orders for all to service_role using (true) with check (true);

revoke all on public.kill_switch, public.risk_limits, public.order_intents, public.orders from anon, authenticated;
grant select, update on public.kill_switch to service_role;
grant select, insert, update on public.risk_limits, public.order_intents, public.orders to service_role;

-- 5) RPCs. The intent insert is one statement. It returns {inserted: true} for a new row, or {inserted: false, row}
--    with the stored row for a repeat. The row is null when the conflict was on intent_id under another key.
create or replace function public.hive_order_intent_insert(p_intent jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.order_intents%rowtype;
begin
  insert into public.order_intents (
    intent_id, idempotency_key, mode, schema_version, action, source, inst_id, side, pos_side, td_mode,
    lever, sz, ord_type, px, reduce_only, sl_trigger_px, sl_ord_px, tp_trigger_px, tp_ord_px,
    theme, theme_stop_cap_u, max_loss_u, reason, intent_created_at, ttl_sec, cl_ord_id, request
  ) values (
    p_intent->>'intent_id', p_intent->>'idempotency_key', p_intent->>'mode', p_intent->>'schema_version',
    p_intent->>'action', p_intent->>'source', p_intent->>'inst_id', p_intent->>'side', p_intent->>'pos_side',
    p_intent->>'td_mode', (p_intent->>'lever')::numeric, (p_intent->>'sz')::numeric, p_intent->>'ord_type',
    (p_intent->>'px')::numeric, coalesce((p_intent->>'reduce_only')::boolean, false),
    (p_intent->>'sl_trigger_px')::numeric, (p_intent->>'sl_ord_px')::numeric,
    (p_intent->>'tp_trigger_px')::numeric, (p_intent->>'tp_ord_px')::numeric,
    p_intent->>'theme', (p_intent->>'theme_stop_cap_u')::numeric, (p_intent->>'max_loss_u')::numeric,
    p_intent->>'reason', (p_intent->>'intent_created_at')::timestamptz, (p_intent->>'ttl_sec')::integer,
    p_intent->>'cl_ord_id', coalesce(p_intent->'request', '{}'::jsonb)
  )
  on conflict do nothing
  returning * into v_row;

  if found then
    return jsonb_build_object('inserted', true);
  end if;

  select * into v_row from public.order_intents where idempotency_key = p_intent->>'idempotency_key';
  if not found then
    return jsonb_build_object('inserted', false, 'row', null);
  end if;

  return jsonb_build_object(
    'inserted', false,
    'row', jsonb_build_object(
      'status', v_row.status,
      'reject_reason', v_row.reject_reason,
      'ord_id', v_row.ord_id,
      'algo_id', v_row.algo_id,
      'cl_ord_id', v_row.cl_ord_id,
      'detail', v_row.detail,
      'received_at', v_row.received_at
    )
  );
end
$$;

create or replace function public.hive_order_intent_finish(p_idempotency_key text, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.order_intents
     set status = p_result->>'status',
         reject_reason = p_result->>'reason',
         ord_id = p_result->>'ord_id',
         algo_id = p_result->>'algo_id',
         detail = p_result->>'detail',
         updated_at = now()
   where idempotency_key = p_idempotency_key;
end
$$;

-- Submissions in the window, for the per-minute rate limit. Counts requests that were accepted for placement, including
-- those still in flight, and excludes the caller's own key.
create or replace function public.hive_order_submissions_since(p_mode text, p_since timestamptz, p_exclude_key text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.order_intents
   where mode = p_mode
     and received_at >= p_since
     and idempotency_key <> p_exclude_key
     and status in ('received', 'acked', 'exchange_error');
$$;

create or replace function public.hive_order_record(p_order jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.orders as o (
    exchange, intent_id, mode, action, kind, inst_id, side, pos_side, ord_type,
    ord_id, algo_id, cl_ord_id, sz, px, state
  ) values (
    'okx', p_order->>'intent_id', p_order->>'mode', p_order->>'action', p_order->>'kind', p_order->>'inst_id',
    p_order->>'side', p_order->>'pos_side', p_order->>'ord_type', p_order->>'ord_id', p_order->>'algo_id',
    p_order->>'cl_ord_id', (p_order->>'sz')::numeric, (p_order->>'px')::numeric,
    coalesce(p_order->>'state', 'accepted')
  )
  on conflict (exchange, cl_ord_id) do update
    set ord_id = coalesce(excluded.ord_id, o.ord_id),
        algo_id = coalesce(excluded.algo_id, o.algo_id),
        state = excluded.state,
        updated_at = now();
end
$$;

create or replace function public.hive_order_set_state(p_cl_ord_id text, p_state text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders set state = p_state, updated_at = now()
   where exchange = 'okx' and cl_ord_id = p_cl_ord_id;
$$;

revoke execute on function public.hive_order_intent_insert(jsonb) from public, anon, authenticated;
revoke execute on function public.hive_order_intent_finish(text, jsonb) from public, anon, authenticated;
revoke execute on function public.hive_order_submissions_since(text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.hive_order_record(jsonb) from public, anon, authenticated;
revoke execute on function public.hive_order_set_state(text, text) from public, anon, authenticated;
grant execute on function public.hive_order_intent_insert(jsonb) to service_role;
grant execute on function public.hive_order_intent_finish(text, jsonb) to service_role;
grant execute on function public.hive_order_submissions_since(text, timestamptz, text) to service_role;
grant execute on function public.hive_order_record(jsonb) to service_role;
grant execute on function public.hive_order_set_state(text, text) to service_role;

-- 6) Conservative demo limits. Demo only: live has no row, so live is refused until someone adds one. Values are
--    starting points for review, not tuned numbers. The allowlist holds the four liquid USDT swaps the team trades.
insert into public.risk_limits (name, mode, symbol_allowlist, max_notional_usdt, max_leverage, max_orders_per_min)
values ('demo-default', 'demo', array['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'XAU-USDT-SWAP'], 500, 20, 5)
on conflict (name) do nothing;
