-- Outbox queue for webhook delivery. deliveries is the source of truth; pgmq only
-- carries delivery ids so a consumer (phase 2) can pick them up without polling tables.
do $$
begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'hive_deliveries') then
    perform pgmq.create('hive_deliveries');
  end if;
end
$$;

create or replace function public.hive_upsert_webhook(p_name text, p_url text, p_secret text default null)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
  v_old_secret uuid;
  v_new_secret uuid;
begin
  select id, secret_id into v_id, v_old_secret from public.webhooks where name = p_name;

  if p_secret is not null then
    v_new_secret := vault.create_secret(p_secret, 'webhook:' || p_name, 'Hive webhook signing secret');
  end if;

  if v_id is null then
    insert into public.webhooks (name, url, secret_id)
    values (p_name, p_url, v_new_secret)
    returning id into v_id;
  else
    update public.webhooks
       set url = p_url, secret_id = coalesce(v_new_secret, v_old_secret), updated_at = now()
     where id = v_id;
    if v_new_secret is not null and v_old_secret is not null then
      delete from vault.secrets where id = v_old_secret;
    end if;
  end if;

  return v_id;
end
$$;

create or replace function public.hive_get_webhook_secret(p_webhook_id uuid)
returns text
language sql
stable
security definer
set search_path = public, vault
as $$
  select ds.decrypted_secret
  from public.webhooks w
  join vault.decrypted_secrets ds on ds.id = w.secret_id
  where w.id = p_webhook_id;
$$;

-- Writes one alert (idempotent on dedup_key), fans out deliveries and enqueues them.
-- Runs in the caller's transaction, so the alert, deliveries and queue messages commit together.
create or replace function public.hive_enqueue_alert(
  p_dedup_key text,
  p_kind text,
  p_symbol text,
  p_rule_id uuid,
  p_payload jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_alert_id bigint;
  v_delivery record;
  v_rule_webhook uuid;
begin
  insert into public.alerts (dedup_key, rule_id, symbol, kind, payload)
  values (p_dedup_key, p_rule_id, p_symbol, p_kind, coalesce(p_payload, '{}'::jsonb))
  on conflict (dedup_key) do nothing
  returning id into v_alert_id;

  if v_alert_id is null then
    return null;
  end if;

  if p_rule_id is not null then
    select webhook_id into v_rule_webhook from public.alert_rules where id = p_rule_id;
    update public.alert_rules set last_triggered_at = now() where id = p_rule_id;
  end if;

  insert into public.deliveries (alert_id, webhook_id)
  select v_alert_id, w.id
    from public.webhooks w
   where w.enabled
     and (v_rule_webhook is null or w.id = v_rule_webhook)
  on conflict (alert_id, webhook_id) do nothing;

  for v_delivery in select d.id from public.deliveries d where d.alert_id = v_alert_id loop
    perform pgmq.send('hive_deliveries', jsonb_build_object('delivery_id', v_delivery.id));
  end loop;

  return v_alert_id;
end
$$;

-- Finds enabled sources whose last successful poll is older than max_staleness_minutes
-- and enqueues one alert per source per 15-minute bucket.
create or replace function public.hive_run_health_check()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_bucket bigint := floor(extract(epoch from now()) / 900)::bigint;
  v_count integer := 0;
begin
  for r in
    select source, max_staleness_minutes, last_success_at, consecutive_failures, last_error
      from public.source_health
     where enabled
       and (last_success_at is null or last_success_at < now() - make_interval(mins => max_staleness_minutes))
  loop
    if public.hive_enqueue_alert(
      'source_stale:' || r.source || ':' || v_bucket,
      'source_stale',
      null,
      null,
      jsonb_build_object(
        'source', r.source,
        'last_success_at', r.last_success_at,
        'consecutive_failures', r.consecutive_failures,
        'last_error', r.last_error
      )
    ) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-health-check') then
    perform cron.unschedule('hive-health-check');
  end if;
end
$$;

select cron.schedule('hive-health-check', '*/5 * * * *', $$select public.hive_run_health_check()$$);
