-- Reduce Nano Disk IO from overlapping high-frequency crons, and bound the
-- daily retention / prune deletes so they cannot lock and scan unbounded.
-- Trading switches, risk limits, strategy bindings and order rows are unchanged;
-- only schedules and delete batching change. Jobs that exist only in production
-- are rescheduled if present and skipped on a fresh CI database.

create or replace function public.clean_old_candles_batch(p_limit integer default 20000)
returns bigint
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_n bigint := 0;
begin
  if not pg_try_advisory_lock(20261107) then
    return 0;
  end if;
  delete from candles
  where ctid in (
    select ctid from candles
    where interval in ('1m', '5m', '15m')
      and ts < now() - interval '7 days'
    order by ts
    limit p_limit
  );
  get diagnostics v_n = row_count;
  perform pg_advisory_unlock(20261107);
  return v_n;
exception
  when others then
    perform pg_advisory_unlock(20261107);
    raise;
end;
$function$;

revoke all on function public.clean_old_candles_batch(integer) from public, anon, authenticated;

create or replace function public.hive_run_retention(
  p_intraday_days integer default 30,
  p_alert_days integer default 30,
  p_history_days integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path = public, cron, net, pgmq
as $function$
declare
  v_intraday_cutoff timestamptz := now() - make_interval(days => p_intraday_days);
  v_alert_cutoff timestamptz := now() - make_interval(days => p_alert_days);
  v_history_cutoff timestamptz := now() - make_interval(days => p_history_days);
  v_batch integer := 5000;
  v_n integer := 0;
  v_candles integer := 0;
  v_alerts integer := 0;
  v_deliveries integer := 0;
  v_queue integer := 0;
  v_queue_archived integer := 0;
  v_cron_history integer := 0;
  v_net_responses integer := 0;
  v_trend_events integer := 0;
begin
  if not pg_try_advisory_lock(20261117) then
    return jsonb_build_object('skipped', true, 'reason', 'already running');
  end if;

  loop
    delete from public.candles
    where ctid in (
      select ctid from public.candles
      where interval <> '1D' and ts < v_intraday_cutoff
      limit v_batch
    );
    get diagnostics v_n = row_count;
    v_candles := v_candles + v_n;
    exit when v_n = 0;
  end loop;

  -- deliveries reference alerts with ON DELETE CASCADE, so this also removes their deliveries.
  loop
    delete from public.alerts
    where ctid in (
      select ctid from public.alerts
      where triggered_at < v_alert_cutoff
      limit v_batch
    );
    get diagnostics v_n = row_count;
    v_alerts := v_alerts + v_n;
    exit when v_n = 0;
  end loop;

  loop
    delete from public.deliveries
    where ctid in (
      select ctid from public.deliveries
      where status in ('delivered', 'dead') and updated_at < v_alert_cutoff
      limit v_batch
    );
    get diagnostics v_n = row_count;
    v_deliveries := v_deliveries + v_n;
    exit when v_n = 0;
  end loop;

  if to_regclass('public.trend_strategy_events') is not null then
    loop
      execute 'delete from public.trend_strategy_events where ctid in (select ctid from public.trend_strategy_events where ts < $1 limit $2)'
        using v_alert_cutoff, v_batch;
      get diagnostics v_n = row_count;
      v_trend_events := v_trend_events + v_n;
      exit when v_n = 0;
    end loop;
  end if;

  if to_regclass('pgmq.q_hive_deliveries') is not null then
    loop
      execute 'delete from pgmq.q_hive_deliveries where ctid in (select ctid from pgmq.q_hive_deliveries where enqueued_at < $1 limit $2)'
        using v_alert_cutoff, v_batch;
      get diagnostics v_n = row_count;
      v_queue := v_queue + v_n;
      exit when v_n = 0;
    end loop;
    loop
      execute 'delete from pgmq.a_hive_deliveries where ctid in (select ctid from pgmq.a_hive_deliveries where archived_at < $1 limit $2)'
        using v_alert_cutoff, v_batch;
      get diagnostics v_n = row_count;
      v_queue_archived := v_queue_archived + v_n;
      exit when v_n = 0;
    end loop;
    v_queue := v_queue + v_queue_archived;
  end if;

  loop
    delete from cron.job_run_details
    where ctid in (
      select ctid from cron.job_run_details
      where end_time < v_history_cutoff
      limit v_batch
    );
    get diagnostics v_n = row_count;
    v_cron_history := v_cron_history + v_n;
    exit when v_n = 0;
  end loop;

  if to_regclass('net._http_response') is not null then
    loop
      execute 'delete from net._http_response where ctid in (select ctid from net._http_response where created < $1 limit $2)'
        using v_history_cutoff, v_batch;
      get diagnostics v_n = row_count;
      v_net_responses := v_net_responses + v_n;
      exit when v_n = 0;
    end loop;
  end if;

  perform pg_advisory_unlock(20261117);
  return jsonb_build_object(
    'candles', v_candles,
    'alerts', v_alerts,
    'deliveries', v_deliveries,
    'queue_messages', v_queue,
    'cron_history', v_cron_history,
    'net_responses', v_net_responses,
    'trend_events', v_trend_events,
    'intraday_cutoff', v_intraday_cutoff,
    'batched', true
  );
exception
  when others then
    perform pg_advisory_unlock(20261117);
    raise;
end;
$function$;

revoke execute on function public.hive_run_retention(integer, integer, integer) from public, anon, authenticated;

create or replace function public.hive_prune_news_and_webhooks(
  p_delivery_days integer default 14,
  p_news_days integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_delivery_cutoff timestamptz := now() - make_interval(days => p_delivery_days);
  v_news_cutoff timestamptz := now() - make_interval(days => p_news_days);
  v_batch integer := 5000;
  v_n integer := 0;
  v_deliveries integer := 0;
  v_events integer := 0;
  v_news integer := 0;
begin
  loop
    delete from public.webhook_deliveries
    where ctid in (
      select ctid from public.webhook_deliveries
      where status in ('delivered', 'dead', 'expired')
        and updated_at < v_delivery_cutoff
      limit v_batch
    );
    get diagnostics v_n = row_count;
    v_deliveries := v_deliveries + v_n;
    exit when v_n = 0;
  end loop;

  loop
    delete from public.news_events
    where ctid in (
      select ctid from public.news_events
      where first_published_at < v_news_cutoff
      limit v_batch
    );
    get diagnostics v_n = row_count;
    v_events := v_events + v_n;
    exit when v_n = 0;
  end loop;

  loop
    delete from public.news_items
    where ctid in (
      select ctid from public.news_items
      where fetched_at < v_news_cutoff
        and id not in (select earliest_item_id from public.news_events where earliest_item_id is not null)
      limit v_batch
    );
    get diagnostics v_n = row_count;
    v_news := v_news + v_n;
    exit when v_n = 0;
  end loop;

  return jsonb_build_object(
    'webhook_deliveries', v_deliveries,
    'news_events', v_events,
    'news_items', v_news,
    'batched', true
  );
end;
$function$;

revoke execute on function public.hive_prune_news_and_webhooks(integer, integer) from public, anon, authenticated;

create or replace function public.hive_ops_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, cron, pg_temp
as $function$
begin
  return jsonb_build_object(
    'ts', now(),
    'db_size_bytes', pg_database_size(current_database()),
    'max_connections', current_setting('max_connections')::int,
    'connections', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where state = 'active'),
        'idle', count(*) filter (where state = 'idle'),
        'idle_in_transaction', count(*) filter (where state = 'idle in transaction')
      )
      from pg_stat_activity
      where datname = current_database()
    ),
    'cache_hit_pct', (
      select case
        when blks_hit + blks_read = 0 then null
        else round(100.0 * blks_hit / (blks_hit + blks_read), 2)
      end
      from pg_stat_database
      where datname = current_database()
    ),
    'cron', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'jobid', jobid,
          'jobname', jobname,
          'schedule', schedule,
          'active', active
        )
        order by jobid
      ), '[]'::jsonb)
      from cron.job
    )
  );
end;
$function$;

revoke all on function public.hive_ops_snapshot() from public, anon, authenticated;
grant execute on function public.hive_ops_snapshot() to service_role;

do $$
declare
  v_id bigint;
  v_job text;
  v_schedule text;
  v_pairs text[][] := array[
    array['hive-okx-collector', '*/2 * * * *'],
    array['hive-jin10-poller', '*/2 * * * *'],
    array['hive-webhook-dispatch', '*/2 * * * *'],
    array['hive-telegram-dispatch', '*/2 * * * *'],
    array['hive-strategy-executor', '*/2 * * * *'],
    array['hive-health-check', '*/2 * * * *'],
    array['hive-okx-news-poller', '*/2 * * * *'],
    array['hive-alert-evaluator', '*/2 * * * *'],
    array['hive-push-notify', '*/2 * * * *'],
    array['hive-yahoo-collector', '*/5 * * * *'],
    array['hive-ths-collector', '*/5 1-7 * * 1-5'],
    array['hive-google-finance-collector', '*/15 * * * *'],
    array['hive-position-manager', '*/5 * * * *'],
    array['hive-strategy-evaluator', '*/5 * * * *'],
    array['hive-order-sync', '*/5 * * * *'],
    array['hive-trend-evaluator', '*/5 * * * *']
  ];
begin
  for i in 1 .. array_length(v_pairs, 1) loop
    v_job := v_pairs[i][1];
    v_schedule := v_pairs[i][2];
    select jobid into v_id from cron.job where jobname = v_job;
    if v_id is null then
      raise notice 'skip cron %: not present', v_job;
    else
      perform cron.alter_job(v_id, schedule := v_schedule);
    end if;
  end loop;

  if not exists (select 1 from cron.job where jobname = 'hive-clean-candles') then
    perform cron.schedule(
      'hive-clean-candles',
      '*/5 * * * *',
      $cmd$select public.clean_old_candles_batch(20000)$cmd$
    );
  end if;
end;
$$;
