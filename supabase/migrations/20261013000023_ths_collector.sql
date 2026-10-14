-- Tonghuashun / HiThink (ths) market data for the ths-collector Edge Function.
-- The function calls the public REST API (same surface as the hithink-finance CLI) and writes:
--   * index and A-share prices  -> quotes_latest (source = 'ths')
--   * pools, ladder, hot stock, anomaly, dragon-tiger, auction, breadth -> daily_snapshot (kind 'ths_*', one row per
--     day and kind, overwritten on each tick). No candles are written.
-- Everything here is additive and idempotent. The ths source stays disabled (source_health.enabled = false and
-- symbol_map.enabled = false) until the post-deploy steps in README "部署 > ths 行情" are run.

-- 1) symbol_map: thscode mapping. ths_kind is explicit because codes alone are ambiguous (000001.SH is the Shanghai
--    index, 000001.SZ is a stock). ths_auction opts a stock into auction-snapshot.
alter table public.symbol_map add column if not exists ths_code text;
alter table public.symbol_map add column if not exists ths_kind text;
alter table public.symbol_map add column if not exists ths_auction boolean not null default false;

alter table public.symbol_map drop constraint if exists symbol_map_ths_code_format;
alter table public.symbol_map add constraint symbol_map_ths_code_format
  check (ths_code is null or ths_code ~ '^[0-9]{6}\.(SH|SZ|BJ|TI)$');

alter table public.symbol_map drop constraint if exists symbol_map_ths_kind_check;
alter table public.symbol_map add constraint symbol_map_ths_kind_check
  check (ths_kind is null or ths_kind in ('stock', 'index'));

alter table public.symbol_map drop constraint if exists symbol_map_ths_pair_check;
alter table public.symbol_map add constraint symbol_map_ths_pair_check
  check ((ths_code is null) = (ths_kind is null));

alter table public.symbol_map drop constraint if exists symbol_map_ths_auction_check;
alter table public.symbol_map add constraint symbol_map_ths_auction_check
  check (not ths_auction or ths_kind = 'stock');

create unique index if not exists symbol_map_ths_code_key on public.symbol_map (ths_code) where ths_code is not null;

-- Seeds. Only thscodes that appear in the HiThink docs are seeded: 000001.SH and 399001.SZ (index snapshot docs),
-- 000300.SH (index constituents docs), 600519.SH and 000858.SZ (A-share snapshot and constituents docs).
-- 399006.SZ (ChiNext) is not in the docs, so it is not seeded. Add it after it verifies live.
-- Seeds are disabled and auction is opt-in. enabled and ths_auction are never reset by a rerun.
insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol, enabled, ths_code, ths_kind) values
  ('SH000001', null, null, false, '000001.SH', 'index'),
  ('SZ399001', null, null, false, '399001.SZ', 'index'),
  ('SH000300', null, null, false, '000300.SH', 'index'),
  ('MOUTAI', null, null, false, '600519.SH', 'stock'),
  ('WULIANGYE', null, null, false, '000858.SZ', 'stock')
on conflict (symbol) do nothing;

-- 2) source_health: session_only limits the source_stale check to the A-share session window, so the
--    overnight and weekend gaps do not raise alerts. The ths row keeps enabled = false from the first migration.
alter table public.source_health add column if not exists session_only boolean not null default false;
update public.source_health
   set session_only = true, max_staleness_minutes = 10, updated_at = now()
 where source = 'ths';

insert into public.collector_state (source) values ('ths') on conflict (source) do nothing;

-- 3) Session window in Asia/Shanghai: weekdays 09:15 (inclusive) to 15:15 (exclusive). Exchange holidays are not
--    modelled here. The collector handles them through the trading calendar.
create or replace function public.hive_a_share_session_open(p_at timestamptz)
returns boolean
language sql
stable
as $$
  select extract(isodow from (p_at at time zone 'Asia/Shanghai')) between 1 and 5
     and (p_at at time zone 'Asia/Shanghai')::time >= time '09:15'
     and (p_at at time zone 'Asia/Shanghai')::time < time '15:15';
$$;

revoke execute on function public.hive_a_share_session_open(timestamptz) from public, anon, authenticated;
grant execute on function public.hive_a_share_session_open(timestamptz) to service_role;

-- 4) Health check: same semantics as migration 14, plus the session gate. A session_only source is evaluated only
--    when the session is open now and was also open max_staleness_minutes ago. This means the first check after
--    the open does not alert before the collector has had one full staleness window. Outside that window the row
--    is left as it is, so an open alert stays open until the next session evaluates it.
create or replace function public.hive_run_health_check()
returns integer
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  r record;
  v_stale boolean;
  v_open boolean;
  v_opened integer := 0;
begin
  for r in
    select source, enabled, session_only, max_staleness_minutes, last_success_at, consecutive_failures, last_error
      from public.source_health
  loop
    if r.session_only and not (
      public.hive_a_share_session_open(now())
      and public.hive_a_share_session_open(now() - make_interval(mins => r.max_staleness_minutes))
    ) then
      continue;
    end if;

    v_stale := r.enabled
      and (r.last_success_at is null or r.last_success_at < now() - make_interval(mins => r.max_staleness_minutes));
    v_open := exists (
      select 1 from public.alerts a
       where a.kind = 'source_stale' and a.resolved_at is null and a.payload->>'source' = r.source::text
    );

    if v_stale and not v_open then
      insert into public.alerts (dedup_key, kind, symbol, severity, payload)
      values (
        'source_stale:' || r.source::text || ':' || gen_random_uuid()::text,
        'source_stale',
        null,
        'warning',
        jsonb_build_object(
          'source', r.source::text,
          'last_success_at', r.last_success_at,
          'consecutive_failures', r.consecutive_failures,
          'last_error', r.last_error,
          'threshold_minutes', r.max_staleness_minutes
        )
      );
      v_opened := v_opened + 1;
    elsif not v_stale and v_open then
      update public.alerts
         set resolved_at = now()
       where kind = 'source_stale' and resolved_at is null and payload->>'source' = r.source::text;
      insert into public.alerts (dedup_key, kind, symbol, severity, payload)
      values (
        'source_recovered:' || r.source::text || ':' || gen_random_uuid()::text,
        'source_recovered',
        null,
        'info',
        jsonb_build_object('source', r.source::text, 'last_success_at', r.last_success_at)
      );
    end if;
  end loop;
  return v_opened;
end
$$;

revoke execute on function public.hive_run_health_check() from public, anon, authenticated;
grant execute on function public.hive_run_health_check() to service_role;

-- 5) Daily snapshot write path. Only ths_* kinds are accepted, so this function cannot touch other sources' rows.
create or replace function public.hive_collector_upsert_daily_snapshot(p_date date, p_kind text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_kind is null or left(p_kind, 4) <> 'ths_' then
    raise exception 'daily snapshot kind must start with ths_';
  end if;
  insert into public.daily_snapshot (snapshot_date, kind, payload, created_at)
  values (p_date, p_kind, coalesce(p_payload, '{}'::jsonb), now())
  on conflict (snapshot_date, kind) do update
    set payload = excluded.payload, created_at = excluded.created_at;
end
$$;

-- Keeps the free-tier database small. Rows are one per kind per day, and the window defaults to 30 days.
create or replace function public.hive_prune_ths_snapshots(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  delete from public.daily_snapshot
   where left(kind, 4) = 'ths_' and snapshot_date < current_date - p_days;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

revoke execute on function public.hive_collector_upsert_daily_snapshot(date, text, jsonb) from public, anon, authenticated;
revoke execute on function public.hive_prune_ths_snapshots(integer) from public, anon, authenticated;
grant execute on function public.hive_collector_upsert_daily_snapshot(date, text, jsonb) to service_role;
grant execute on function public.hive_prune_ths_snapshots(integer) to service_role;

-- 6) Schedules. pg_cron runs in UTC. 01:00 to 07:58 UTC on weekdays is 09:00 to 15:58 Beijing time, and the function
--    applies the exact 09:15 to 15:15 window and the trading calendar itself. Even minutes only, so the 10-minute
--    group lines up. That is about 210 Edge invocations per weekday (roughly 4,600 per month, under the 500,000 limit).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-ths-collector') then
    perform cron.unschedule('hive-ths-collector');
  end if;
  if exists (select 1 from cron.job where jobname = 'hive-ths-prune') then
    perform cron.unschedule('hive-ths-prune');
  end if;
end
$$;

select cron.schedule('hive-ths-collector', '*/2 1-7 * * 1-5', $$select public.hive_invoke_edge_function('ths-collector')$$);
select cron.schedule('hive-ths-prune', '40 3 * * *', $$select public.hive_prune_ths_snapshots()$$);
