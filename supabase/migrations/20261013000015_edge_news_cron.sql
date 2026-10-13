-- Schedules the news pollers and the webhook dispatcher. They share one invoker: pg_cron calls
-- hive_invoke_edge_function(name), which reads the project's functions base URL and a cron bearer secret
-- from Vault and POSTs through pg_net. Nothing secret is stored in cron.job.
-- Vault secrets (create once, see README):
--   edge_base_url    https://<project-ref>.supabase.co/functions/v1
--   edge_cron_secret same value as the EDGE_CRON_SECRET Edge secret

create or replace function public.hive_invoke_edge_function(p_name text)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_base text;
  v_secret text;
begin
  if p_name is null or p_name !~ '^[a-z0-9-]{1,64}$' then
    raise exception 'invalid edge function name';
  end if;

  select ds.decrypted_secret into v_base from vault.decrypted_secrets ds where ds.name = 'edge_base_url';
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'edge_cron_secret';

  if v_base is null or v_secret is null then
    raise warning 'edge functions are not configured: create Vault secrets edge_base_url and edge_cron_secret';
    return null;
  end if;

  return net.http_post(
    url := rtrim(v_base, '/') || '/' || p_name,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 30000
  );
end
$$;

revoke execute on function public.hive_invoke_edge_function(text) from public, anon, authenticated;

-- Deletes delivery log rows and old news. News that is still the earliest item of an event is kept,
-- because news_events.earliest_item_id references it.
create or replace function public.hive_prune_news_and_webhooks(
  p_delivery_days integer default 14,
  p_news_days integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deliveries integer := 0;
  v_events integer := 0;
  v_news integer := 0;
begin
  delete from public.webhook_deliveries
   where status in ('delivered', 'dead')
     and updated_at < now() - make_interval(days => p_delivery_days);
  get diagnostics v_deliveries = row_count;

  delete from public.news_events where first_published_at < now() - make_interval(days => p_news_days);
  get diagnostics v_events = row_count;

  delete from public.news_items
   where fetched_at < now() - make_interval(days => p_news_days)
     and id not in (select earliest_item_id from public.news_events where earliest_item_id is not null);
  get diagnostics v_news = row_count;

  return jsonb_build_object('webhook_deliveries', v_deliveries, 'news_events', v_events, 'news_items', v_news);
end
$$;

revoke execute on function public.hive_prune_news_and_webhooks(integer, integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-jin10-poller') then
    perform cron.unschedule('hive-jin10-poller');
  end if;
  if exists (select 1 from cron.job where jobname = 'hive-webhook-dispatch') then
    perform cron.unschedule('hive-webhook-dispatch');
  end if;
  if exists (select 1 from cron.job where jobname = 'hive-news-prune') then
    perform cron.unschedule('hive-news-prune');
  end if;
end
$$;

select cron.schedule('hive-jin10-poller', '30 seconds', $$select public.hive_invoke_edge_function('jin10-poller')$$);
select cron.schedule('hive-webhook-dispatch', '* * * * *', $$select public.hive_invoke_edge_function('webhook-dispatcher')$$);
select cron.schedule('hive-news-prune', '27 3 * * *', $$select public.hive_prune_news_and_webhooks()$$);
