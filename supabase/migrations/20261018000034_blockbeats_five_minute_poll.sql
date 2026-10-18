-- BlockBeats polling cadence: every 5 minutes instead of every minute. The feed posts only a few
-- items per hour, so minute-level polling bought nothing but Edge Function invocations: at one
-- minute the job alone would add 1,440 calls/day against the free plan's 500k/month budget
-- (see the quota note in README.md). Five minutes keeps worst-case news latency at about five
-- minutes for this supplementary source; jin10 remains the fast lane at 30 seconds.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-blockbeats-poller') then
    perform cron.unschedule('hive-blockbeats-poller');
  end if;
end
$$;

select cron.schedule('hive-blockbeats-poller', '*/5 * * * *', $$select public.hive_invoke_edge_function('blockbeats-poller')$$);
