-- Keeps the database well under the 500MB free-tier limit. Daily bars (1D) are kept indefinitely;
-- intraday bars, alerts and deliveries older than the retention window are removed. pg_cron and
-- pg_net write run history on every tick, so that history is pruned as well.
create or replace function public.hive_run_retention(
  p_intraday_days integer default 30,
  p_alert_days integer default 30,
  p_history_days integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path = public, cron, net, pgmq
as $$
declare
  v_intraday_cutoff timestamptz := now() - make_interval(days => p_intraday_days);
  v_alert_cutoff timestamptz := now() - make_interval(days => p_alert_days);
  v_candles integer := 0;
  v_alerts integer := 0;
  v_deliveries integer := 0;
  v_queue integer := 0;
  v_queue_archived integer := 0;
  v_cron_history integer := 0;
  v_net_responses integer := 0;
begin
  delete from public.candles where interval <> '1D' and ts < v_intraday_cutoff;
  get diagnostics v_candles = row_count;

  -- deliveries reference alerts with ON DELETE CASCADE, so this also removes their deliveries.
  delete from public.alerts where triggered_at < v_alert_cutoff;
  get diagnostics v_alerts = row_count;

  delete from public.deliveries where status in ('delivered', 'dead') and updated_at < v_alert_cutoff;
  get diagnostics v_deliveries = row_count;

  if to_regclass('pgmq.q_hive_deliveries') is not null then
    execute 'delete from pgmq.q_hive_deliveries where enqueued_at < $1' using v_alert_cutoff;
    get diagnostics v_queue = row_count;
    execute 'delete from pgmq.a_hive_deliveries where archived_at < $1' using v_alert_cutoff;
    get diagnostics v_queue_archived = row_count;
    v_queue := v_queue + v_queue_archived;
  end if;

  delete from cron.job_run_details where end_time < now() - make_interval(days => p_history_days);
  get diagnostics v_cron_history = row_count;

  if to_regclass('net._http_response') is not null then
    execute 'delete from net._http_response where created < now() - make_interval(days => $1)' using p_history_days;
    get diagnostics v_net_responses = row_count;
  end if;

  return jsonb_build_object(
    'candles', v_candles,
    'alerts', v_alerts,
    'deliveries', v_deliveries,
    'queue_messages', v_queue,
    'cron_history', v_cron_history,
    'net_responses', v_net_responses,
    'intraday_cutoff', v_intraday_cutoff
  );
end
$$;

revoke execute on function public.hive_run_retention(integer, integer, integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-retention') then
    perform cron.unschedule('hive-retention');
  end if;
end
$$;

select cron.schedule('hive-retention', '17 3 * * *', $$select public.hive_run_retention()$$);
