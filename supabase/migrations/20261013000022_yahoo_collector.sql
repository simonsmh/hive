-- Yahoo Finance quotes and bars under source = 'yahoo'. The yahoo-collector Edge Function reads the public chart API
-- every two minutes and writes through the existing hive_collector_* functions. Those take p_source, so no SQL function
-- changes are needed here. Lease and backoff use the collector_state row for 'yahoo'.
-- source_health.yahoo is left disabled. Quotes and bars flow as soon as the job runs, but the source_stale alert stays
-- off until someone enables it after checking the first live run (see README, "部署 > Yahoo 行情"). Additive and idempotent.

insert into public.collector_state (source) values ('yahoo') on conflict (source) do nothing;

insert into public.source_health (source, enabled, max_staleness_minutes) values ('yahoo', false, 30)
on conflict (source) do nothing;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-yahoo-collector') then
    perform cron.unschedule('hive-yahoo-collector');
  end if;
end
$$;

-- 720 runs a day, about 21,600 a month, against the 500,000 free-tier Edge invocation limit.
select cron.schedule('hive-yahoo-collector', '*/2 * * * *', $$select public.hive_invoke_edge_function('yahoo-collector')$$);
