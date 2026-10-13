-- Schedules the okx-collector Edge Function every 30 seconds. pg_cron calls the tick, the tick reads
-- the function URL and bearer secret from Vault at run time, and pg_net posts to the function.
-- Nothing secret is stored in cron.job. Create the Vault secrets before the first tick, otherwise
-- the tick logs a warning and does nothing (see README, "部署 > Supabase").
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/okx-collector', 'okx_collector_url');
--   select vault.create_secret('<same value as the COLLECTOR_SECRET Edge secret>', 'okx_collector_secret');

create or replace function public.hive_okx_collector_tick()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_url text;
  v_secret text;
begin
  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'okx_collector_url';
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'okx_collector_secret';

  if v_url is null or v_secret is null then
    raise warning 'okx-collector is not configured: create Vault secrets okx_collector_url and okx_collector_secret';
    return null;
  end if;

  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 120000
  );
end
$$;

revoke execute on function public.hive_okx_collector_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-okx-collector') then
    perform cron.unschedule('hive-okx-collector');
  end if;
end
$$;

select cron.schedule('hive-okx-collector', '30 seconds', $$select public.hive_okx_collector_tick()$$);
