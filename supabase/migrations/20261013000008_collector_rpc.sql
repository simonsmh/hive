-- Write path for the okx-collector Edge Function. Each function holds the same statement as the
-- worker's pg store (apps/worker/src/store.ts), so both collectors keep identical table semantics.
-- The Edge Function calls these over PostgREST with the service role key only.

-- Lease and rate-limit backoff for the collector. A run takes the lease before polling, so
-- overlapping 30-second ticks skip instead of double-polling OKX.
create table public.collector_state (
  source public.market_source primary key,
  lease_holder uuid,
  lease_until timestamptz,
  backoff_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_outcome text,
  last_summary jsonb,
  updated_at timestamptz not null default now()
);

insert into public.collector_state (source) values ('okx') on conflict (source) do nothing;

alter table public.collector_state enable row level security;
create policy service_role_all on public.collector_state for all to service_role using (true) with check (true);
revoke all on public.collector_state from anon, authenticated;

create or replace function public.hive_collector_begin(p_source text, p_holder uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.collector_state (source)
  values (p_source::public.market_source)
  on conflict (source) do nothing;

  update public.collector_state
     set lease_holder = p_holder,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         last_started_at = now(),
         updated_at = now()
   where source = p_source::public.market_source
     and (lease_until is null or lease_until < now())
     and (backoff_until is null or backoff_until <= now());
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;

create or replace function public.hive_collector_finish(
  p_source text,
  p_holder uuid,
  p_outcome text,
  p_backoff_seconds integer,
  p_summary jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.collector_state
     set lease_holder = case when lease_holder = p_holder then null else lease_holder end,
         lease_until = case when lease_holder = p_holder then null else lease_until end,
         backoff_until = case when p_backoff_seconds > 0 then now() + make_interval(secs => p_backoff_seconds) else null end,
         last_finished_at = now(),
         last_outcome = p_outcome,
         last_summary = coalesce(p_summary, '{}'::jsonb),
         updated_at = now()
   where source = p_source::public.market_source;
$$;

create or replace function public.hive_collector_upsert_quote(
  p_symbol text,
  p_source text,
  p_price numeric,
  p_ts_ms bigint
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.quotes_latest (symbol, source, price, ts, updated_at)
  values (p_symbol, p_source::public.market_source, p_price, to_timestamp(p_ts_ms::double precision / 1000), now())
  on conflict (symbol, source) do update
    set price = excluded.price, ts = excluded.ts, updated_at = now()
    where excluded.ts >= public.quotes_latest.ts;
$$;

create or replace function public.hive_collector_upsert_candles(
  p_symbol text,
  p_source text,
  p_interval text,
  p_candles jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.candles (symbol, source, interval, ts, open, high, low, close, volume, vol_ccy, confirmed, updated_at)
  select p_symbol, p_source::public.market_source, p_interval,
         to_timestamp(c.ts::double precision / 1000),
         c.open, c.high, c.low, c.close, c.volume, c.vol_ccy, c.confirmed, now()
    from jsonb_to_recordset(p_candles)
      as c(ts bigint, open numeric, high numeric, low numeric, close numeric, volume numeric, vol_ccy numeric, confirmed boolean)
  on conflict (symbol, source, interval, ts) do update
    set open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
        volume = excluded.volume, vol_ccy = excluded.vol_ccy, confirmed = excluded.confirmed,
        updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

create or replace function public.hive_collector_record_success(p_source text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.source_health (source, last_success_at, consecutive_failures, last_error, updated_at)
  values (p_source::public.market_source, now(), 0, null, now())
  on conflict (source) do update
    set last_success_at = now(), consecutive_failures = 0, last_error = null, updated_at = now();
$$;

create or replace function public.hive_collector_record_failure(p_source text, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.source_health (source, consecutive_failures, last_error, updated_at)
  values (p_source::public.market_source, 1, left(p_error, 500), now())
  on conflict (source) do update
    set consecutive_failures = public.source_health.consecutive_failures + 1,
        last_error = excluded.last_error,
        updated_at = now();
$$;

revoke execute on function public.hive_collector_begin(text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.hive_collector_finish(text, uuid, text, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.hive_collector_upsert_quote(text, text, numeric, bigint) from public, anon, authenticated;
revoke execute on function public.hive_collector_upsert_candles(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.hive_collector_record_success(text) from public, anon, authenticated;
revoke execute on function public.hive_collector_record_failure(text, text) from public, anon, authenticated;

grant execute on function public.hive_collector_begin(text, uuid, integer) to service_role;
grant execute on function public.hive_collector_finish(text, uuid, text, integer, jsonb) to service_role;
grant execute on function public.hive_collector_upsert_quote(text, text, numeric, bigint) to service_role;
grant execute on function public.hive_collector_upsert_candles(text, text, text, jsonb) to service_role;
grant execute on function public.hive_collector_record_success(text) to service_role;
grant execute on function public.hive_collector_record_failure(text, text) to service_role;
