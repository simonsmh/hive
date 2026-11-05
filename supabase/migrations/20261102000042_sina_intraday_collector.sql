-- Sina intraday 5m K-lines for the trial symbol, under source = 'sina'
-- and interval = '5m', feeding the alert-evaluator's volume_spike rules.
-- The sina-intraday-collector Edge Function reads symbol_map rows with
-- enabled = true and a ths_code but only polls its hard-coded whitelist
-- (SH513310); widening that list is a deliberate follow-up, not a config
-- flip, so no other symbol can start emitting intraday alerts unreviewed.
-- No SQL function changes are needed. Lease and backoff reuse the
-- collector_state row for 'sina' shared with sina-daily-collector: the two
-- schedules do not overlap (intraday ticks end at 15:00 Beijing, the daily
-- run is at 15:35), and the 600s rate-limit backoff cannot bridge that gap.
-- No source_health change either: 'sina' stays on its 7-day threshold with
-- enabled = false until a first successful run is confirmed, per the daily
-- migration's reasoning.
--
-- Schedules. pg_cron runs in UTC. '*/5 1-3,5-6 * * 1-5' is 09:00-11:59 and
-- 13:00-14:59 Beijing on weekdays, covering both sessions with 5-minute
-- ticks. Ticks outside a session (pre-open, lunch, holidays) fetch the last
-- trading day's bars and re-upsert identical rows, so they are harmless
-- no-ops. One gap is intentional: the final 14:55-15:00 bar has no tick
-- after 15:00, so it is backfilled by the next morning's first tick (the
-- fetch window covers ~2.5 trading days and the bar is confirmed by then,
-- since its day is past). About 60 ticks per weekday, ~1,320 a month,
-- against the 500,000 free-tier Edge invocation limit.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-sina-intraday-collector') then
    perform cron.unschedule('hive-sina-intraday-collector');
  end if;
end
$$;

select cron.schedule('hive-sina-intraday-collector', '*/5 1-3,5-6 * * 1-5', $$select public.hive_invoke_edge_function('sina-intraday-collector')$$);
