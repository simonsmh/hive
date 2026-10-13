-- Schema smoke test. Runs inside a transaction that is rolled back, so it leaves no data behind.
-- Usage: psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/verify.sql
begin;

do $$
declare
  t text;
  n integer;
  queue_count integer;
  v_webhook uuid;
  v_first integer;
  v_second integer;
  v_queued integer;
  v_secret_id uuid;
  v_secret text;
  v_no_rls text;
begin
  -- Every required table exists and has RLS enabled.
  foreach t in array array[
    'symbol_map', 'candles', 'quotes_latest', 'daily_snapshot', 'source_health',
    'news_events', 'news_items', 'fills', 'alert_rules', 'alerts', 'deliveries', 'webhooks'
  ] loop
    perform 1 from pg_tables where schemaname = 'public' and tablename = t;
    if not found then raise exception 'missing table public.%', t; end if;
    perform 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if not found then raise exception 'RLS not enabled on public.%', t; end if;
  end loop;

  -- Every table in public must have RLS enabled, including ones added later.
  select string_agg(c.relname, ', ') into v_no_rls
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if v_no_rls is not null then raise exception 'RLS disabled on public tables: %', v_no_rls; end if;

  -- Extensions used by Hive are installed.
  foreach t in array array['pg_cron', 'pg_net', 'pgmq', 'supabase_vault'] loop
    perform 1 from pg_extension where extname = t;
    if not found then raise exception 'extension % is not installed', t; end if;
  end loop;

  perform 1 from pg_views where schemaname = 'public' and viewname = 'v_spread';
  if not found then raise exception 'missing view v_spread'; end if;

  -- Candle primary key is (symbol, source, interval, ts).
  select count(*) into n
    from information_schema.table_constraints tc
    join information_schema.key_column_usage k
      on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
   where tc.table_schema = 'public' and tc.table_name = 'candles' and tc.constraint_type = 'PRIMARY KEY';
  if n <> 4 then raise exception 'candles primary key should have 4 columns, found %', n; end if;

  -- Clients must not be able to read tables directly.
  if has_table_privilege('anon', 'public.candles', 'SELECT')
     or has_table_privilege('authenticated', 'public.alerts', 'SELECT') then
    raise exception 'anon/authenticated must not have direct table privileges';
  end if;

  -- Queue and cron job exist.
  select count(*) into queue_count from pgmq.list_queues() where queue_name = 'hive_deliveries';
  if queue_count <> 1 then raise exception 'pgmq queue hive_deliveries missing'; end if;
  perform 1 from cron.job where jobname = 'hive-health-check' and schedule = '*/5 * * * *';
  if not found then raise exception 'pg_cron job hive-health-check missing'; end if;

  -- Webhook secret goes to Vault, not into a plaintext column.
  v_webhook := public.hive_upsert_webhook('verify-hook', 'https://example.com/hook', 'hunter2-test-secret');
  select secret_id into v_secret_id from public.webhooks where id = v_webhook;
  if v_secret_id is null then raise exception 'webhook secret was not stored in vault'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret <> 'hunter2-test-secret' then raise exception 'vault round-trip failed'; end if;

  -- Health check: okx has never succeeded, so one alert and one queued delivery are expected.
  v_first := public.hive_run_health_check();
  if v_first <> 1 then raise exception 'expected 1 stale-source alert, got %', v_first; end if;

  -- Same 15-minute bucket must not alert twice.
  v_second := public.hive_run_health_check();
  if v_second <> 0 then raise exception 'health check is not idempotent within a bucket (% new alerts)', v_second; end if;

  select count(*) into v_queued from pgmq.read('hive_deliveries', 30, 10);
  if v_queued <> 1 then raise exception 'expected 1 queued delivery message, got %', v_queued; end if;

  -- Market data round trip: candles upsert on the composite key and quotes_latest feeds the spread view.
  insert into public.candles (symbol, source, interval, ts, open, high, low, close, volume, vol_ccy, confirmed)
  values ('NVDA', 'okx', '1m', now(), 10, 12, 9, 11, 5, 55, true)
  on conflict (symbol, source, interval, ts) do update set close = excluded.close;
  insert into public.quotes_latest (symbol, source, price, ts) values
    ('BTC', 'okx', 100, now()), ('BTC', 'yahoo', 99, now());
  perform 1 from public.v_spread where symbol = 'BTC' and spread = 1;
  if not found then raise exception 'v_spread did not compute BTC spread'; end if;

  -- Invariant: candle high must not be below low.
  begin
    insert into public.candles (symbol, source, interval, ts, open, high, low, close)
    values ('NVDA', 'okx', '1m', now() - interval '1 minute', 1, 1, 2, 1);
    raise exception 'candle with high < low was accepted';
  exception when check_violation then
    null;
  end;

  -- Alert dedup key is unique.
  begin
    insert into public.alerts (dedup_key, kind) values ('dup', 'test');
    insert into public.alerts (dedup_key, kind) values ('dup', 'test');
    raise exception 'duplicate alert dedup_key was accepted';
  exception when unique_violation then
    null;
  end;

  raise notice 'verify.sql: all schema checks passed';
end
$$;

rollback;
