-- Google Finance earnings guidance and live transcript, collected only inside call windows.
-- The google-finance-collector Edge Function replays two unauthenticated RPCs (see packages/core/src/google-finance.ts).
-- Nothing is scheduled by this migration. The tick function below is a no-op outside an enabled row's window, so a cron
-- job can be added during a call week and removed afterwards (README, "部署 > Google Finance 财报").
-- Additive and idempotent: safe to re-run.

-- 1) Health row for the collector. Disabled, because it only runs during call windows and a staleness alert would fire
--    every other hour of the day.
insert into public.collector_state (source) values ('google-finance-earnings') on conflict (source) do nothing;
insert into public.source_health (source, enabled, max_staleness_minutes) values ('google-finance-earnings', false, 30)
on conflict (source) do nothing;

-- 2) Watch list. One row per Google Finance listing. TSM:NYSE is primary and maps to Hive TSM (and its OKX perpetual
--    through symbol_map). 2330:TPE is an alias for the same company and is disabled by default, so the same call is not
--    polled twice. Alert dedup is keyed on the Hive symbol, so enabling both still produces one alert per value.
create table public.earnings_watch (
  google_symbol text primary key check (google_symbol ~ '^[A-Z0-9.]{1,12}:[A-Z]{2,6}$'),
  symbol text not null references public.symbol_map (symbol) on delete cascade,
  is_primary boolean not null default false,
  enabled boolean not null default false,
  -- Absolute start of the call. Google's "Call Time" is shown in the viewer's time zone, so set this from the company's
  -- IR calendar, not from the page.
  call_time timestamptz,
  pre_minutes integer not null default 30 check (pre_minutes between 0 and 1440),
  post_minutes integer not null default 180 check (post_minutes between 0 and 1440),
  finhub_bl text,
  finhub_sid text,
  finhub_refreshed_at timestamptz,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not enabled or call_time is not null)
);
create unique index earnings_watch_one_primary_per_symbol on public.earnings_watch (symbol) where is_primary;

insert into public.earnings_watch (google_symbol, symbol, is_primary, enabled) values
  ('TSM:NYSE', 'TSM', true, false),
  ('2330:TPE', 'TSM', false, false)
on conflict (google_symbol) do nothing;

-- 3) Guidance snapshots. One row per distinct set of glance cards plus extracted figures, so a poll that changes nothing
--    writes nothing.
create table public.earnings_guidance_snapshots (
  id bigint generated always as identity primary key,
  symbol text not null references public.symbol_map (symbol) on delete cascade,
  google_symbol text not null,
  payload_hash text not null check (length(payload_hash) = 64),
  cards jsonb not null default '[]'::jsonb,
  key_numbers jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (symbol, payload_hash)
);
create index earnings_guidance_snapshots_symbol_fetched_idx on public.earnings_guidance_snapshots (symbol, fetched_at desc);

-- 4) Transcript segments, stored as a delta. Each timed segment is written once, keyed by a hash of its start time and text.
create table public.earnings_transcript_segments (
  id bigint generated always as identity primary key,
  symbol text not null references public.symbol_map (symbol) on delete cascade,
  google_symbol text not null,
  seg_hash text not null check (length(seg_hash) = 64),
  start_sec numeric not null,
  end_sec numeric not null,
  body text not null check (length(body) > 0),
  first_seen_at timestamptz not null default now(),
  unique (symbol, seg_hash)
);
create index earnings_transcript_segments_symbol_seen_idx on public.earnings_transcript_segments (symbol, first_seen_at desc, start_sec);

alter table public.earnings_watch enable row level security;
alter table public.earnings_guidance_snapshots enable row level security;
alter table public.earnings_transcript_segments enable row level security;

create policy service_role_all on public.earnings_watch for all to service_role using (true) with check (true);
create policy service_role_all on public.earnings_guidance_snapshots for all to service_role using (true) with check (true);
create policy service_role_all on public.earnings_transcript_segments for all to service_role using (true) with check (true);

revoke all on public.earnings_watch, public.earnings_guidance_snapshots, public.earnings_transcript_segments from anon, authenticated;

-- 5) Write path. One call per poll, in one transaction: watch heartbeat, snapshot, new segments, then alerts. An alert
--    whose dedup_key already exists is skipped, so repeated polls are idempotent. Inserting into alerts fires
--    alerts_fanout, which is the only path to webhooks; this function never calls a webhook itself.
create or replace function public.hive_earnings_record(
  p_google_symbol text,
  p_symbol text,
  p_snapshot jsonb,
  p_segments jsonb,
  p_alerts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_snapshots integer := 0;
  v_segments integer := 0;
  v_alerts integer := 0;
  v_item jsonb;
  v_id bigint;
begin
  if p_symbol is null or p_symbol !~ '^[A-Z0-9]{1,20}$' then
    raise exception 'invalid symbol %', p_symbol;
  end if;

  update public.earnings_watch
     set last_polled_at = now(), updated_at = now()
   where google_symbol = p_google_symbol;

  if jsonb_typeof(p_snapshot) = 'object' then
    insert into public.earnings_guidance_snapshots (symbol, google_symbol, payload_hash, cards, key_numbers, fetched_at)
    values (p_symbol, p_google_symbol, p_snapshot->>'payload_hash', coalesce(p_snapshot->'cards', '[]'::jsonb),
            coalesce(p_snapshot->'key_numbers', '{}'::jsonb), coalesce((p_snapshot->>'fetched_at')::timestamptz, now()))
    on conflict (symbol, payload_hash) do nothing;
    get diagnostics v_snapshots = row_count;
  end if;

  insert into public.earnings_transcript_segments (symbol, google_symbol, seg_hash, start_sec, end_sec, body)
  select p_symbol, p_google_symbol, s.seg_hash, s.start_sec, s.end_sec, s.body
    from jsonb_to_recordset(coalesce(p_segments, '[]'::jsonb))
      as s(seg_hash text, start_sec numeric, end_sec numeric, body text)
  on conflict (symbol, seg_hash) do nothing;
  get diagnostics v_segments = row_count;

  for v_item in select value from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) loop
    v_id := null;
    insert into public.alerts (dedup_key, rule_id, symbol, kind, severity, payload)
    values (v_item->>'dedup_key', null, v_item->>'symbol', v_item->>'kind', v_item->>'severity',
            coalesce(v_item->'payload', '{}'::jsonb))
    on conflict (dedup_key) do nothing
    returning id into v_id;
    if v_id is not null then v_alerts := v_alerts + 1; end if;
  end loop;

  return jsonb_build_object('snapshots', v_snapshots, 'segments', v_segments, 'alerts', v_alerts);
end
$$;

revoke execute on function public.hive_earnings_record(text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.hive_earnings_record(text, text, jsonb, jsonb, jsonb) to service_role;

-- 6) Tick for pg_cron. It calls the collector only when an enabled row is inside its window, so a scheduled job costs a
--    SQL check and no network call outside a call. No job is scheduled here. Enable it with the README steps.
create or replace function public.hive_google_finance_earnings_tick()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
begin
  if not exists (
    select 1
      from public.earnings_watch w
     where w.enabled
       and w.call_time is not null
       and now() between w.call_time - make_interval(mins => w.pre_minutes)
                      and w.call_time + make_interval(mins => w.post_minutes)
  ) then
    return null;
  end if;
  return public.hive_invoke_edge_function('google-finance-collector');
end
$$;

revoke execute on function public.hive_google_finance_earnings_tick() from public, anon, authenticated;

-- 7) Retention. Segments and snapshots are kept for 90 days, which covers a quarter of comparison.
create or replace function public.hive_prune_earnings(p_days integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_segments integer := 0;
  v_snapshots integer := 0;
begin
  delete from public.earnings_transcript_segments where first_seen_at < now() - make_interval(days => p_days);
  get diagnostics v_segments = row_count;
  delete from public.earnings_guidance_snapshots where fetched_at < now() - make_interval(days => p_days);
  get diagnostics v_snapshots = row_count;
  return jsonb_build_object('transcript_segments', v_segments, 'guidance_snapshots', v_snapshots);
end
$$;

revoke execute on function public.hive_prune_earnings(integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-earnings-prune') then
    perform cron.unschedule('hive-earnings-prune');
  end if;
end
$$;

select cron.schedule('hive-earnings-prune', '43 3 * * *', $$select public.hive_prune_earnings()$$);

-- 8) Priority for the new alert kind. Guidance changes are critical: claimed first, never expired, stale after 120 s.
--    Other kinds keep their existing policy. This changes priority for new deliveries only, not subscription rows.
create or replace function public.hive_delivery_policy(p_event_type text, p_kind text)
returns table (priority text, stale_after_seconds integer, expires_after_seconds integer)
language sql
immutable
as $$
  select
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                         'earnings_guidance')
         then 'critical' else 'bulk' end,
    case when p_kind = 'fill' then 60
         when p_event_type = 'alert'
           and p_kind in ('near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                          'earnings_guidance') then 120
         else 300 end,
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                         'earnings_guidance')
         then null else 900 end
$$;

revoke all on function public.hive_delivery_policy(text, text) from public, anon, authenticated;
