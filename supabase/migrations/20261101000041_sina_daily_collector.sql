-- Sina daily K-lines for A-share symbols under source = 'sina'.
-- The sina-daily-collector Edge Function reads symbol_map rows with
-- enabled = true and a ths_code, derives the Sina code from ths_code
-- (000001.SH -> sh000001, 399001.SZ -> sz399001, 600487.SH -> sh600487),
-- and writes only 1D candles through the existing hive_collector_* functions.
-- No symbol is seeded here: a new symbol enters by adding its ths_code in
-- the dashboard symbol manager, and a row without ths_code is skipped.
-- No SQL function changes are needed. Lease and backoff use the
-- collector_state row for 'sina'.

insert into public.collector_state (source) values ('sina') on conflict (source) do nothing;

-- source_health for a once-a-day, post-close source. The seeded row from
-- market_data.sql is ('sina', false, 30): a 30-minute threshold would fire
-- every night and weekend, because the next run is a full trading day away.
-- A session_only gate (ths) does not fit either: it evaluates only while
-- the session is open, so a Friday 15:35 success would look stale at Monday
-- 09:15, before Monday's 15:35 run has had a chance to happen.
-- Instead the threshold is widened to 7 days (10080 minutes). That covers
-- the normal Friday -> Monday gap (3 days) and holiday weekends, at the cost
-- of slow stale detection: a genuinely broken collector is caught within a
-- week by this alert, and sooner from collector_state.last_outcome and the
-- pg_cron job history. A trading-calendar-aware gate is the follow-up if
-- tighter detection is ever needed; it is not smuggled in here.
-- enabled stays false here, following the yahoo precedent: a source that
-- has never succeeded counts as stale no matter how wide the threshold is,
-- so enabling before the first successful run would open a false alert.
-- Enable it only after the first run is confirmed (see README, "新浪日线").
insert into public.source_health (source, enabled, max_staleness_minutes) values ('sina', false, 10080)
on conflict (source) do update
  set enabled = false, max_staleness_minutes = 10080, updated_at = now();

-- Schedules. pg_cron runs in UTC. 07:35 UTC on weekdays is 15:35 Beijing
-- time, after the 15:00 A-share close, so the day's bar is final and is
-- written confirmed = true by the collector. One run per weekday, about
-- 22 runs a month, against the 500,000 free-tier Edge invocation limit.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-sina-daily-collector') then
    perform cron.unschedule('hive-sina-daily-collector');
  end if;
end
$$;

select cron.schedule('hive-sina-daily-collector', '35 7 * * 1-5', $$select public.hive_invoke_edge_function('sina-daily-collector')$$);
