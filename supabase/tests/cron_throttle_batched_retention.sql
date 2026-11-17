-- Offline/local check for 20261117000052_cron_throttle_batched_retention.sql.
-- Do not point DATABASE_URL at production.

\set ON_ERROR_STOP 1

do $$
declare
  v_sched text;
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'clean_old_candles_batch'
  ) then
    raise exception 'missing clean_old_candles_batch';
  end if;

  if position('limit v_batch' in pg_get_functiondef('public.hive_run_retention(integer,integer,integer)'::regprocedure)) = 0 then
    raise exception 'hive_run_retention is not batched';
  end if;

  if position('limit v_batch' in pg_get_functiondef('public.hive_prune_news_and_webhooks(integer,integer)'::regprocedure)) = 0 then
    raise exception 'hive_prune_news_and_webhooks is not batched';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hive_ops_snapshot'
  ) then
    raise exception 'missing hive_ops_snapshot';
  end if;

  select schedule into v_sched from cron.job where jobname = 'hive-okx-collector';
  if v_sched is not null and v_sched is distinct from '*/2 * * * *' then
    raise exception 'hive-okx-collector schedule is %, expected */2 * * * *', v_sched;
  end if;

  select schedule into v_sched from cron.job where jobname = 'hive-health-check';
  if v_sched is not null and v_sched is distinct from '*/2 * * * *' then
    raise exception 'hive-health-check schedule is %, expected */2 * * * *', v_sched;
  end if;

  select schedule into v_sched from cron.job where jobname = 'hive-yahoo-collector';
  if v_sched is not null and v_sched is distinct from '*/5 * * * *' then
    raise exception 'hive-yahoo-collector schedule is %, expected */5 * * * *', v_sched;
  end if;

  select schedule into v_sched from cron.job where jobname = 'hive-google-finance-collector';
  if v_sched is not null and v_sched is distinct from '*/15 * * * *' then
    raise exception 'hive-google-finance-collector schedule is %, expected */15 * * * *', v_sched;
  end if;

  if not exists (select 1 from cron.job where jobname = 'hive-clean-candles') then
    raise exception 'missing hive-clean-candles cron';
  end if;

  raise notice 'cron_throttle_batched_retention: schedules and batched functions ok';
end
$$;
