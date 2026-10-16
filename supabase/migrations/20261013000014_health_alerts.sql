-- Health alerts with open/resolve semantics. A source that is enabled and older than its
-- max_staleness_minutes gets one open 'source_stale' alert, and no new one while that alert is open.
-- When the source recovers (or is disabled) the open alert gets resolved_at and a 'source_recovered'
-- event is written. Each insert fans out to webhook subscribers through alerts_fanout.
-- The check runs every minute because the news thresholds (jin10 5 min) are shorter than the old 5-minute cadence.

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
    select source, enabled, max_staleness_minutes, last_success_at, consecutive_failures, last_error
      from public.source_health
  loop
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

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-health-check') then
    perform cron.unschedule('hive-health-check');
  end if;
end
$$;

select cron.schedule('hive-health-check', '* * * * *', $$select public.hive_run_health_check()$$);
