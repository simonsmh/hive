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

  -- Worker health writes (same statements as recordSourceSuccess / recordSourceFailure in apps/worker/src/store.ts).
  insert into public.source_health (source, last_success_at, consecutive_failures, last_error, updated_at)
  values ('okx', now(), 0, null, now())
  on conflict (source) do update
    set last_success_at = now(), consecutive_failures = 0, last_error = null, updated_at = now();
  insert into public.source_health (source, consecutive_failures, last_error, updated_at)
  values ('okx', 1, 'boom', now())
  on conflict (source) do update
    set consecutive_failures = source_health.consecutive_failures + 1, last_error = excluded.last_error, updated_at = now();
  perform 1 from public.source_health
   where source = 'okx' and last_success_at is not null and consecutive_failures = 1 and last_error = 'boom';
  if not found then raise exception 'worker health upsert did not persist'; end if;

  -- Every default worker symbol has a symbol_map seed (see packages/core DEFAULT_SYMBOLS).
  foreach t in array array['BZ', 'SNDK', 'MU', 'META', 'NVDA', 'QQQ', 'MRNA', 'TSM', 'XAU', 'BTC', 'ETH'] loop
    perform 1 from public.symbol_map where symbol = t and okx_inst_id = t || '-USDT-SWAP';
    if not found then raise exception 'symbol_map is missing the % seed', t; end if;
  end loop;

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

-- okx-collector Edge Function write path, scheduling, retention and Vault wiring.
-- Symbol VERIFY is used so checks never touch real rows; the whole file rolls back.
do $$
declare
  fn text;
  v_holder uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_rows integer;
  v_price numeric;
  v_close numeric;
  v_count integer;
  v_failures integer;
  v_error text;
  v_result jsonb;
  v_tick bigint;
begin
  foreach fn in array array[
    'hive_collector_begin(text,uuid,integer)',
    'hive_collector_finish(text,uuid,text,integer,jsonb)',
    'hive_collector_upsert_quote(text,text,numeric,bigint)',
    'hive_collector_upsert_candles(text,text,text,jsonb)',
    'hive_collector_record_success(text)',
    'hive_collector_record_failure(text,text)',
    'hive_okx_collector_tick()',
    'hive_run_retention(integer,integer,integer)'
  ] loop
    if to_regprocedure('public.' || fn) is null then raise exception 'missing function public.%', fn; end if;
  end loop;

  if has_function_privilege('anon', 'public.hive_collector_begin(text,uuid,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_collector_upsert_quote(text,text,numeric,bigint)', 'EXECUTE')
     or has_function_privilege('anon', 'public.hive_run_retention(integer,integer,integer)', 'EXECUTE') then
    raise exception 'collector functions must not be executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.hive_collector_begin(text,uuid,integer)', 'EXECUTE') then
    raise exception 'service_role must be able to execute the collector RPCs';
  end if;

  perform 1 from cron.job where jobname = 'hive-okx-collector' and schedule = '30 seconds';
  if not found then raise exception 'pg_cron job hive-okx-collector with 30 second schedule missing'; end if;
  perform 1 from cron.job where jobname = 'hive-retention' and schedule = '17 3 * * *';
  if not found then raise exception 'pg_cron job hive-retention missing'; end if;

  -- Lease: one holder at a time, released on finish.
  if not public.hive_collector_begin('okx', v_holder, 150) then raise exception 'first lease should be granted'; end if;
  if public.hive_collector_begin('okx', v_second, 150) then raise exception 'lease granted while another run holds it'; end if;
  perform public.hive_collector_finish('okx', v_holder, 'ok', 0, '{"successes": 1}'::jsonb);
  if not public.hive_collector_begin('okx', v_second, 150) then raise exception 'lease should be free after finish'; end if;

  -- Rate-limit backoff blocks the next run until it expires.
  perform public.hive_collector_finish('okx', v_second, 'rate_limited', 300, '{}'::jsonb);
  if public.hive_collector_begin('okx', gen_random_uuid(), 150) then raise exception 'backoff did not block the next run'; end if;
  update public.collector_state set backoff_until = null where source = 'okx';
  if not public.hive_collector_begin('okx', gen_random_uuid(), 150) then raise exception 'lease should be granted once backoff is cleared'; end if;

  -- Quote guard: an older timestamp never overwrites a newer quote.
  perform public.hive_collector_upsert_quote('VERIFY', 'okx', 100, 1000000000000);
  perform public.hive_collector_upsert_quote('VERIFY', 'okx', 200, 1000000001000);
  perform public.hive_collector_upsert_quote('VERIFY', 'okx', 300, 999999999000);
  select price into v_price from public.quotes_latest where symbol = 'VERIFY' and source = 'okx';
  if v_price <> 200 then raise exception 'quote guard failed: expected 200, got %', v_price; end if;

  -- Candles: idempotent on (symbol, source, interval, ts) and count the rows written.
  v_rows := public.hive_collector_upsert_candles('VERIFY', 'okx', '5m',
    '[{"ts":1000000000000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":10,"vol_ccy":15,"confirmed":true},
      {"ts":1000000300000,"open":1,"high":2,"low":0.5,"close":1.6,"volume":10,"vol_ccy":15,"confirmed":false}]'::jsonb);
  if v_rows <> 2 then raise exception 'expected 2 candles written, got %', v_rows; end if;
  v_rows := public.hive_collector_upsert_candles('VERIFY', 'okx', '5m',
    '[{"ts":1000000000000,"open":1,"high":9,"low":0.5,"close":9,"volume":10,"vol_ccy":15,"confirmed":true}]'::jsonb);
  select close into v_close from public.candles where symbol = 'VERIFY' and interval = '5m' and ts = to_timestamp(1000000000000 / 1000.0);
  select count(*) into v_count from public.candles where symbol = 'VERIFY' and interval = '5m';
  if v_close <> 9 or v_count <> 2 then raise exception 'candle upsert failed (close %, rows %)', v_close, v_count; end if;

  -- Source health: failure accumulates, success resets it.
  perform public.hive_collector_record_failure('okx', 'probe failure');
  select consecutive_failures into v_failures from public.source_health where source = 'okx';
  perform public.hive_collector_record_failure('okx', 'probe failure again');
  select consecutive_failures into v_count from public.source_health where source = 'okx';
  if v_count <> v_failures + 1 then raise exception 'consecutive_failures did not increase'; end if;
  perform public.hive_collector_record_success('okx');
  select consecutive_failures, last_error into v_count, v_error from public.source_health where source = 'okx';
  if v_count <> 0 or v_error is not null then raise exception 'success did not reset source_health'; end if;

  -- Retention: intraday bars older than 30 days go, daily bars stay.
  insert into public.candles (symbol, source, interval, ts, open, high, low, close) values
    ('VERIFY', 'okx', '1m', now() - interval '60 days', 1, 1, 1, 1),
    ('VERIFY', 'okx', '1m', now() - interval '1 day', 1, 1, 1, 1),
    ('VERIFY', 'okx', '1D', now() - interval '60 days', 1, 1, 1, 1);
  v_result := public.hive_run_retention();
  select count(*) into v_count from public.candles where symbol = 'VERIFY' and interval = '1m' and ts < now() - interval '30 days';
  if v_count <> 0 then raise exception 'retention kept % intraday candles older than 30 days', v_count; end if;
  select count(*) into v_count from public.candles where symbol = 'VERIFY' and interval = '1m' and ts > now() - interval '30 days';
  if v_count <> 1 then raise exception 'retention removed a recent 1m candle'; end if;
  select count(*) into v_count from public.candles where symbol = 'VERIFY' and interval = '1D' and ts < now() - interval '30 days';
  if v_count <> 1 then raise exception 'retention removed a daily bar'; end if;
  if not (v_result ? 'candles' and v_result ? 'alerts' and v_result ? 'queue_messages' and v_result ? 'cron_history') then
    raise exception 'hive_run_retention returned unexpected summary %', v_result;
  end if;

  -- Tick: no-op until both Vault secrets exist, then enqueues one pg_net request.
  delete from vault.secrets where name in ('okx_collector_url', 'okx_collector_secret');
  v_tick := public.hive_okx_collector_tick();
  if v_tick is not null then raise exception 'tick should do nothing without Vault secrets'; end if;
  perform vault.create_secret('http://127.0.0.1:9/okx-collector', 'okx_collector_url', 'verify');
  perform vault.create_secret('verify-collector-secret', 'okx_collector_secret', 'verify');
  v_tick := public.hive_okx_collector_tick();
  if v_tick is null then raise exception 'tick should enqueue a pg_net request once secrets exist'; end if;

  raise notice 'verify.sql: okx-collector checks passed';
end
$$;

rollback;
