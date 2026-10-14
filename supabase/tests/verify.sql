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
    'news_events', 'news_items', 'fills', 'alert_rules', 'alerts', 'deliveries', 'webhooks',
    'webhook_subscriptions', 'webhook_deliveries', 'kill_switch', 'risk_limits', 'order_intents', 'orders'
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
  perform 1 from cron.job where jobname = 'hive-health-check' and schedule = '* * * * *';
  if not found then raise exception 'pg_cron job hive-health-check (every minute) missing'; end if;

  -- Webhook secret goes to Vault, not into a plaintext column.
  v_webhook := public.hive_upsert_webhook('verify-hook', 'https://example.com/hook', 'hunter2-test-secret');
  select secret_id into v_secret_id from public.webhooks where id = v_webhook;
  if v_secret_id is null then raise exception 'webhook secret was not stored in vault'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret <> 'hunter2-test-secret' then raise exception 'vault round-trip failed'; end if;

  -- Health check: okx, jin10 and okx-news have never succeeded, so each gets one open stale alert.
  v_first := public.hive_run_health_check();
  if v_first <> 3 then raise exception 'expected 3 stale-source alerts (okx, jin10, okx-news), got %', v_first; end if;

  -- An open alert is not duplicated while the source stays stale.
  v_second := public.hive_run_health_check();
  if v_second <> 0 then raise exception 'health check duplicated an open alert (% new alerts)', v_second; end if;
  select count(*) into v_queued from public.alerts
   where kind = 'source_stale' and resolved_at is null and payload->>'source' in ('okx', 'jin10', 'okx-news');
  if v_queued <> 3 then raise exception 'expected 3 open stale alerts, got %', v_queued; end if;

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

-- News ingest, prefilter fan-out, webhook claim/mark, subscription management, alert lifecycle and the
-- Edge invoker. Uses only VERIFY-prefixed keys and agent names; the transaction rolls back at the end.
do $$
declare
  v_news_sub uuid;
  v_alert_sub uuid;
  v_filtered_sub uuid;
  v_disabled_sub uuid;
  v_sources_sub uuid;
  v_token_sub uuid;
  v_hits integer;
  v_result jsonb;
  v_count integer;
  v_status text;
  v_claim record;
  v_opened integer;
  v_kick_before integer;
  v_kick_after integer;
  v_secret_name text;
  v_rotated text;
  v_okx_sub uuid;
  v_latest timestamptz;
  v_items text := '[
    {"external_id":"VERIFY-1","title":null,"body":"美联储官员称黄金仍有支撑","url":"https://flash.jin10.com/detail/VERIFY-1","author":null,"published_at":"2026-10-13T09:40:00Z","score":1},
    {"external_id":"VERIFY-2","title":"原油","body":"原油库存意外增加","url":"https://flash.jin10.com/detail/VERIFY-2","author":"金十数据","published_at":"2026-10-13T09:41:00Z","score":0}
  ]';
begin
  -- Prefilter rules used by the fan-out triggers.
  if not public.hive_subscription_matches('{"keywords":["黄金"]}', 'jin10', 'info', null, null, '美联储 黄金 上涨') then
    raise exception 'keyword prefilter should match body text';
  end if;
  if public.hive_subscription_matches('{"keywords":["黄金"]}', 'jin10', 'info', null, null, '原油') then
    raise exception 'keyword prefilter matched an unrelated item';
  end if;
  if not public.hive_subscription_matches('{}', 'jin10', 'info', null, null, 'anything') then
    raise exception 'an empty filter must match every event';
  end if;
  if public.hive_subscription_matches('{"sources":["x"]}', 'jin10', 'info', null, null, 'a') then
    raise exception 'source filter let through a different source';
  end if;
  if public.hive_subscription_matches('{"alert_kinds":["source_stale"]}', 'jin10', 'info', null, null, 'a') then
    raise exception 'alert_kinds filter must not match news, which has no alert kind';
  end if;
  if not public.hive_subscription_matches('{"severities":["critical"],"symbols":["BTC"]}', null, 'critical', 'price_cross', 'BTC', 'x') then
    raise exception 'combined severity and symbol filter should match';
  end if;
  if public.hive_subscription_matches('{"severities":["critical"],"symbols":["BTC"]}', null, 'warning', 'price_cross', 'BTC', 'x') then
    raise exception 'severity filter let a warning through';
  end if;

  -- Subscriptions: one keyword news subscriber, one alert subscriber, one filtered alert subscriber, one disabled.
  v_news_sub := public.hive_upsert_webhook_subscription(null, 'verify-news-agent', 'https://agent.example.com/hook',
    'verify-secret-0123456789abcdef0123', array['news'], '{"keywords":["黄金"]}', true);
  v_alert_sub := public.hive_upsert_webhook_subscription(null, 'verify-alert-agent', 'https://alert.example.com/hook',
    'verify-alert-secret-0123456789abcdef', array['alert'], '{}', true);
  v_filtered_sub := public.hive_upsert_webhook_subscription(null, 'verify-filtered-agent', 'https://filtered.example.com/hook',
    'verify-filter-secret-0123456789abcdef', array['alert'], '{"severities":["critical"],"alert_kinds":["price_cross"],"symbols":["BTC"]}', true);
  v_disabled_sub := public.hive_upsert_webhook_subscription(null, 'verify-disabled-agent', 'https://off.example.com/hook',
    'verify-off-secret-0123456789abcdefgh', array['news', 'alert'], '{}', false);

  -- Ingest: new items create events and news rows; a second poll of the same window only counts duplicates.
  v_result := public.hive_news_ingest('jin10', v_items::jsonb);
  if (v_result->>'inserted')::integer <> 2 then raise exception 'expected 2 inserted news items, got %', v_result; end if;
  select count(*) into v_count from public.news_items where dedup_hash in ('jin10:VERIFY-1', 'jin10:VERIFY-2') and event_id is not null;
  if v_count <> 2 then raise exception 'ingested news rows must each link to an event (found %)', v_count; end if;
  select count(*) into v_count from public.news_items where dedup_hash = 'jin10:VERIFY-1' and score = 1 and author is null;
  if v_count <> 1 then raise exception 'news importance score or author not stored'; end if;

  v_result := public.hive_news_ingest('jin10', v_items::jsonb);
  if (v_result->>'inserted')::integer <> 0 or (v_result->>'duplicates')::integer <> 2 then
    raise exception 're-polling the same items must not insert (got %)', v_result;
  end if;
  select count(*) into v_count from public.news_events where earliest_item_id in
    (select id from public.news_items where dedup_hash like 'jin10:VERIFY-%');
  if v_count <> 2 then raise exception 'duplicate polls left orphan events (%)', v_count; end if;

  perform 1 from public.source_health where source = 'jin10' and consecutive_failures = 0 and last_success_at > now() - interval '1 minute';
  if not found then raise exception 'successful ingest must refresh the jin10 heartbeat'; end if;

  begin
    perform public.hive_news_ingest('okx', '[]'::jsonb);
    raise exception 'news ingest accepted an unsupported source';
  exception when others then
    if sqlerrm not like 'unsupported news source%' then raise; end if;
  end;

  -- Kick: a poll that inserts news queues one dispatcher request; a duplicate-only poll queues none.
  delete from vault.secrets where name in ('edge_base_url', 'edge_cron_secret');
  perform vault.create_secret('http://127.0.0.1:9/functions/v1', 'edge_base_url', 'verify');
  perform vault.create_secret('verify-edge-secret', 'edge_cron_secret', 'verify');
  select count(*) into v_kick_before from net.http_request_queue where url like '%/webhook-dispatcher';
  v_result := public.hive_news_ingest('jin10', '[
    {"external_id":"VERIFY-3","title":null,"body":"无关快讯 VERIFY-3","url":"https://flash.jin10.com/detail/VERIFY-3","author":null,"published_at":"2026-10-13T09:42:00Z","score":0}
  ]'::jsonb);
  select count(*) into v_kick_after from net.http_request_queue where url like '%/webhook-dispatcher';
  if (v_result->>'inserted')::integer <> 1 or v_kick_after - v_kick_before <> 1 then
    raise exception 'a poll with new news must queue exactly one dispatcher kick (inserted %, queued %)', v_result->>'inserted', v_kick_after - v_kick_before;
  end if;
  v_kick_before := v_kick_after;
  v_result := public.hive_news_ingest('jin10', '[
    {"external_id":"VERIFY-3","title":null,"body":"无关快讯 VERIFY-3","url":"https://flash.jin10.com/detail/VERIFY-3","author":null,"published_at":"2026-10-13T09:42:00Z","score":0}
  ]'::jsonb);
  select count(*) into v_kick_after from net.http_request_queue where url like '%/webhook-dispatcher';
  if v_kick_after <> v_kick_before then raise exception 'a duplicate-only poll must not kick the dispatcher'; end if;
  -- OKX Orbit news: same ingest path under its own source string. A sources filter of okx-news matches it, and jin10 does not.
  v_okx_sub := public.hive_upsert_webhook_subscription(null, 'verify-okx-agent', 'https://okx.example.com/hook',
    'verify-okx-secret-0123456789abcdef', array['news'], '{"sources":["okx-news"]}', true);
  v_items := '[
    {"external_id":"VERIFY-OKX-1","title":"比特币","body":"比特币现货 ETF 获批","url":"https://www.okx.com/zh-hans/feed/post/VERIFY-OKX-1","author":"Reuters","published_at":"2026-10-13T09:45:00Z","score":1}
  ]';
  select count(*) into v_kick_before from net.http_request_queue where url like '%/webhook-dispatcher';
  v_result := public.hive_news_ingest('okx-news', v_items::jsonb);
  if (v_result->>'inserted')::integer <> 1 then raise exception 'expected 1 okx-news item inserted, got %', v_result; end if;
  select count(*) into v_kick_after from net.http_request_queue where url like '%/webhook-dispatcher';
  if v_kick_after - v_kick_before <> 1 then raise exception 'an okx-news poll with new items must queue one dispatcher kick'; end if;
  v_result := public.hive_news_ingest('okx-news', v_items::jsonb);
  if (v_result->>'inserted')::integer <> 0 or (v_result->>'duplicates')::integer <> 1 then
    raise exception 'okx-news re-poll must not insert (got %)', v_result;
  end if;
  select count(*) into v_count from public.news_items where dedup_hash = 'okx-news:VERIFY-OKX-1' and score = 1 and event_id is not null;
  if v_count <> 1 then raise exception 'okx-news item not stored with score 1 and an event'; end if;
  perform 1 from public.source_health where source = 'okx-news' and consecutive_failures = 0 and last_success_at > now() - interval '1 minute';
  if not found then raise exception 'successful okx-news ingest must refresh its heartbeat'; end if;
  select public.hive_news_latest_published('okx-news') into v_latest;
  if v_latest is null or v_latest < '2026-10-13T09:45:00Z'::timestamptz then
    raise exception 'watermark did not reflect the newest okx-news item (%)', v_latest;
  end if;
  select count(*) into v_count from public.webhook_deliveries where subscription_id = v_okx_sub;
  if v_count <> 1 then raise exception 'okx-news source filter expected exactly 1 delivery, got %', v_count; end if;

  -- Fan-out: only the keyword subscriber matching VERIFY-1 gets a news delivery.
  select count(*) into v_count from public.webhook_deliveries where subscription_id = v_news_sub and event_type = 'news';
  if v_count <> 1 then raise exception 'keyword news subscriber expected 1 delivery, got %', v_count; end if;
  select count(*) into v_count from public.webhook_deliveries where subscription_id in (v_alert_sub, v_filtered_sub, v_disabled_sub);
  if v_count <> 0 then raise exception 'non-matching subscribers were woken by news (%)', v_count; end if;

  -- Alert fan-out: a critical BTC price cross matches both alert subscribers; a warning ETH volume spike matches only the unfiltered one.
  insert into public.alerts (dedup_key, kind, symbol, severity, payload)
  values ('verify-alert-btc', 'price_cross', 'BTC', 'critical', '{"price": 90000, "threshold": 90000}');
  insert into public.alerts (dedup_key, kind, symbol, severity, payload)
  values ('verify-alert-eth', 'volume_spike', 'ETH', 'warning', '{"volume": 9}');

  select count(*) into v_count from public.webhook_deliveries where subscription_id = v_alert_sub and event_type = 'alert';
  if v_count <> 2 then raise exception 'unfiltered alert subscriber expected 2 deliveries, got %', v_count; end if;
  select count(*) into v_count from public.webhook_deliveries where subscription_id = v_filtered_sub;
  if v_count <> 1 then raise exception 'filtered alert subscriber expected 1 delivery, got %', v_count; end if;
  select count(*) into v_count from public.webhook_deliveries where subscription_id = v_disabled_sub;
  if v_count <> 0 then raise exception 'disabled subscriber received deliveries'; end if;

  -- Claim: returns the decrypted secret, increments attempts, and holds a lease against a second claim.
  select * into v_claim from public.hive_webhook_claim(50, 120) c where c.agent_name = 'verify-news-agent';
  if v_claim.delivery_id is null then raise exception 'claim did not return the due news delivery'; end if;
  if v_claim.secret <> 'verify-secret-0123456789abcdef0123' then raise exception 'claim did not return the decrypted signing secret'; end if;
  if v_claim.attempts <> 1 or v_claim.max_attempts <> 6 or v_claim.event_type <> 'news' then
    raise exception 'claim returned unexpected attempt metadata (attempts %, max %)', v_claim.attempts, v_claim.max_attempts;
  end if;
  if v_claim.payload->>'type' <> 'news' or v_claim.payload->>'title' is not null then
    raise exception 'delivery payload does not match the news envelope';
  end if;
  select count(*) into v_count from public.hive_webhook_claim(50, 120) c where c.delivery_id = v_claim.delivery_id;
  if v_count <> 0 then raise exception 'a leased delivery was claimed twice'; end if;
  select count(*) into v_count from public.hive_webhook_claim(50, 120) c where c.agent_name = 'verify-disabled-agent';
  if v_count <> 0 then raise exception 'disabled subscriber was claimed'; end if;

  -- Failure: retried after the backoff, not before.
  v_status := public.hive_webhook_mark(v_claim.delivery_id, false, 500, 'HTTP 500', 30);
  if v_status <> 'pending' then raise exception 'failed delivery should be pending, got %', v_status; end if;
  select count(*) into v_count from public.hive_webhook_claim(50, 120) c where c.delivery_id = v_claim.delivery_id;
  if v_count <> 0 then raise exception 'backoff was not respected'; end if;

  -- Exhausting attempts marks the delivery dead.
  update public.webhook_deliveries set attempts = 5, next_attempt_at = now() where id = v_claim.delivery_id;
  select * into v_claim from public.hive_webhook_claim(50, 120) c where c.delivery_id = v_claim.delivery_id;
  if v_claim.attempts <> 6 then raise exception 'expected attempt 6 on the final try, got %', v_claim.attempts; end if;
  v_status := public.hive_webhook_mark(v_claim.delivery_id, false, 503, 'HTTP 503', 3600);
  if v_status <> 'dead' then raise exception 'delivery should be dead after max attempts, got %', v_status; end if;

  -- Success is final.
  select * into v_claim from public.hive_webhook_claim(50, 120) c where c.agent_name = 'verify-alert-agent' limit 1;
  v_status := public.hive_webhook_mark(v_claim.delivery_id, true, 200, null, 0);
  if v_status <> 'delivered' then raise exception 'successful delivery should be delivered, got %', v_status; end if;

  -- Subscription management: partial update keeps filters and secret; rotation replaces the Vault entry.
  perform public.hive_upsert_webhook_subscription(v_news_sub, null, null, null, null, null, false);
  perform 1 from public.webhook_subscriptions where id = v_news_sub and enabled = false and filters = '{"keywords":["黄金"]}'::jsonb;
  if not found then raise exception 'partial update reset filters or did not disable'; end if;

  perform public.hive_upsert_webhook_subscription(v_news_sub, null, null, 'rotated-secret-0123456789abcdef0123', null, null, null);
  select ds.decrypted_secret into v_rotated from public.webhook_subscriptions s
    join vault.decrypted_secrets ds on ds.id = s.secret_id where s.id = v_news_sub;
  if v_rotated <> 'rotated-secret-0123456789abcdef0123' then raise exception 'secret rotation did not take effect'; end if;
  select count(*) into v_count from vault.secrets where name like 'webhook_sub:' || v_news_sub::text || ':%';
  if v_count <> 1 then raise exception 'rotation should leave exactly one Vault entry, found %', v_count; end if;

  -- A sources filter applies to news only: an alert from another source still reaches the subscriber.
  v_sources_sub := public.hive_upsert_webhook_subscription(null, 'verify-sources-agent', 'https://sources.example.com/hook',
    'verify-sources-secret-0123456789abcdef', array['alert'], '{"sources":["jin10"]}', true);
  v_token_sub := public.hive_upsert_webhook_subscription(null, 'verify-token-agent', 'https://token.example.com/hook',
    'verify-token-secret-0123456789abcdef', array['alert'], '{}', true, 'verify-bearer-0123456789abcdef', false);
  insert into public.alerts (dedup_key, kind, symbol, severity, payload)
    values ('verify-sources-alert:' || gen_random_uuid()::text, 'price_cross', 'BTC', 'info', '{"source":"okx"}');
  select count(*) into v_count from public.webhook_deliveries where subscription_id = v_sources_sub and event_type = 'alert';
  if v_count <> 1 then raise exception 'sources filter blocked an alert (found %)', v_count; end if;

  -- The bearer token is returned by the claim only, never stored in the row, and absent when not configured.
  select count(*) into v_count from vault.secrets where name like 'webhook_auth:' || v_token_sub::text || ':%';
  if v_count <> 1 then raise exception 'bearer token should be stored once in Vault, found %', v_count; end if;
  -- One claim covers both subscribers: a claim leases every due row, not only the rows of one agent.
  select count(*) filter (where c.agent_name = 'verify-token-agent' and c.auth_token = 'verify-bearer-0123456789abcdef'),
         count(*) filter (where c.agent_name = 'verify-sources-agent' and c.auth_token is null)
    into v_hits, v_count
    from public.hive_webhook_claim(1000, 120) c;
  if v_hits <> 1 then raise exception 'token subscriber did not receive the alert with its decrypted bearer token (found %)', v_hits; end if;
  if v_count <> 1 then raise exception 'sources subscriber did not receive the alert without a bearer token (found %)', v_count; end if;

  perform public.hive_upsert_webhook_subscription(v_token_sub, null, null, 'token-secret-rotated-0123456789abcdef', null, null, null, null, false);
  select count(*) into v_count from public.webhook_subscriptions where id = v_token_sub and auth_token_secret_id is not null;
  if v_count <> 1 then raise exception 'updating the signing secret dropped the bearer token'; end if;

  perform public.hive_upsert_webhook_subscription(v_token_sub, null, null, null, null, null, null, 'rotated-bearer-0123456789abcdef', false);
  select ds.decrypted_secret into v_rotated from public.webhook_subscriptions s
    join vault.decrypted_secrets ds on ds.id = s.auth_token_secret_id where s.id = v_token_sub;
  if v_rotated <> 'rotated-bearer-0123456789abcdef' then raise exception 'bearer token rotation did not take effect'; end if;
  select count(*) into v_count from vault.secrets where name like 'webhook_auth:' || v_token_sub::text || ':%';
  if v_count <> 1 then raise exception 'token rotation should leave exactly one Vault entry, found %', v_count; end if;

  begin
    perform public.hive_upsert_webhook_subscription(v_token_sub, null, null, null, null, null, null, 'conflicting-bearer-0123456789', true);
    raise exception 'setting and clearing the bearer token in one call was accepted';
  exception when sqlstate '22023' then
    null;
  end;

  perform public.hive_upsert_webhook_subscription(v_token_sub, null, null, null, null, null, null, null, true);
  select count(*) into v_count from public.webhook_subscriptions where id = v_token_sub and auth_token_secret_id is null;
  if v_count <> 1 then raise exception 'clearing the bearer token did not unlink it'; end if;
  select count(*) into v_count from vault.secrets where name like 'webhook_auth:' || v_token_sub::text || ':%';
  if v_count <> 0 then raise exception 'clearing the bearer token left a Vault entry behind'; end if;

  perform public.hive_upsert_webhook_subscription(v_token_sub, null, null, null, null, null, null, 'final-bearer-0123456789abcdef', false);
  if public.hive_delete_webhook_subscription(v_token_sub) is not true then raise exception 'token subscriber delete failed'; end if;
  select count(*) into v_count from vault.secrets where name like 'webhook_auth:' || v_token_sub::text || ':%';
  if v_count <> 0 then raise exception 'deleting a subscription left its bearer token in Vault'; end if;

  if public.hive_delete_webhook_subscription(v_disabled_sub) is not true then raise exception 'delete did not report success'; end if;
  select count(*) into v_count from public.webhook_subscriptions where id = v_disabled_sub;
  if v_count <> 0 then raise exception 'deleted subscription still present'; end if;
  if public.hive_delete_webhook_subscription(v_disabled_sub) is not false then raise exception 'second delete should report not found'; end if;

  begin
    perform public.hive_upsert_webhook_subscription(gen_random_uuid(), null, 'https://x.example.com/h', null, null, null, null);
    raise exception 'update of an unknown subscription was accepted';
  exception when sqlstate 'P0002' then
    null;
  end;

  -- Health lifecycle: recovery resolves open alerts and writes a recovery event; a new stale period opens a new alert.
  update public.source_health set last_success_at = now() where source = 'okx';
  v_opened := public.hive_run_health_check();
  if v_opened <> 0 then raise exception 'recovery run opened % alerts', v_opened; end if;
  select count(*) into v_count from public.alerts where kind = 'source_stale' and resolved_at is null and payload->>'source' in ('okx', 'jin10');
  if v_count <> 0 then raise exception 'recovered sources still have open stale alerts (%)', v_count; end if;
  select count(*) into v_count from public.alerts where kind = 'source_recovered' and payload->>'source' in ('okx', 'jin10');
  if v_count <> 2 then raise exception 'expected 2 recovery events, got %', v_count; end if;

  update public.source_health set last_success_at = now() - interval '10 minutes' where source = 'jin10';
  v_opened := public.hive_run_health_check();
  if v_opened <> 1 then raise exception 'jin10 going stale should open exactly one alert, got %', v_opened; end if;

  -- Disabling a source resolves its open alert instead of leaving it dangling.
  update public.source_health set enabled = false where source = 'jin10';
  v_opened := public.hive_run_health_check();
  if v_opened <> 0 then raise exception 'disabled source must not open alerts'; end if;
  select count(*) into v_count from public.alerts where kind = 'source_stale' and resolved_at is null and payload->>'source' = 'jin10';
  if v_count <> 0 then raise exception 'disabling a source did not resolve its open alert'; end if;

  -- Only service_role may run the new write paths.
  if has_function_privilege('anon', 'public.hive_news_ingest(text,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.hive_news_latest_published(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_news_latest_published(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_webhook_claim(integer,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.hive_upsert_webhook_subscription(uuid,text,text,text,text[],jsonb,boolean,text,boolean)', 'EXECUTE') then
    raise exception 'news or webhook RPCs executable by anon or authenticated';
  end if;
  if has_table_privilege('authenticated', 'public.webhook_deliveries', 'SELECT')
     or has_table_privilege('anon', 'public.webhook_subscriptions', 'SELECT') then
    raise exception 'webhook tables are readable by client roles';
  end if;

  -- Edge invoker: no-op until Vault holds the base URL and cron secret, then one pg_net request.
  delete from vault.secrets where name in ('edge_base_url', 'edge_cron_secret');
  if public.hive_invoke_edge_function('jin10-poller') is not null then raise exception 'edge invoker should no-op without Vault secrets'; end if;
  perform vault.create_secret('http://127.0.0.1:9/functions/v1', 'edge_base_url', 'verify');
  perform vault.create_secret('verify-edge-secret', 'edge_cron_secret', 'verify');
  if public.hive_invoke_edge_function('jin10-poller') is null then raise exception 'edge invoker should enqueue a request once configured'; end if;
  begin
    perform public.hive_invoke_edge_function('Bad Name!');
    raise exception 'edge invoker accepted an invalid function name';
  exception when others then
    if sqlerrm <> 'invalid edge function name' then raise; end if;
  end;

  -- Schedules for the new jobs.
  perform 1 from cron.job where jobname = 'hive-jin10-poller' and schedule = '30 seconds';
  if not found then raise exception 'pg_cron job hive-jin10-poller (30 seconds) missing'; end if;
  perform 1 from cron.job where jobname = 'hive-webhook-dispatch' and schedule = '30 seconds';
  if not found then raise exception 'pg_cron job hive-webhook-dispatch (30 seconds) missing'; end if;
  perform 1 from cron.job where jobname = 'hive-okx-news-poller' and schedule = '* * * * *';
  if not found then raise exception 'pg_cron job hive-okx-news-poller (every minute) missing'; end if;

  v_result := public.hive_prune_news_and_webhooks();
  if not (v_result ? 'webhook_deliveries' and v_result ? 'news_items') then
    raise exception 'prune returned unexpected summary %', v_result;
  end if;

  raise notice 'verify.sql: news, webhook and health lifecycle checks passed';
end
$$;

-- Alert evaluation: the pct_move kind, the seeded rules and SKHY, the record RPC and its cron schedule.
do $$
declare
  v_rule uuid;
  v_result jsonb;
  v_count integer;
  v_last timestamptz;
begin
  begin
    insert into public.alert_rules (name, symbol, kind, params) values ('verify-bad-kind', 'BTC', 'moon', '{}');
    raise exception 'alert_rules accepted an unknown kind';
  exception when check_violation then null;
  end;

  perform 1 from public.symbol_map where symbol = 'SKHY' and enabled;
  if not found then raise exception 'symbol_map is missing an enabled SKHY row'; end if;

  select count(*) into v_count from public.alert_rules
   where kind = 'pct_move' and enabled and cooldown_seconds = 600 and symbol in ('SNDK', 'MU', 'SKHY')
     and params = '{"interval":"1m","lookback":10,"minAbsPct":1}'::jsonb;
  if v_count <> 3 then raise exception 'expected 3 seeded pct_move rules for SNDK, MU and SKHY, got %', v_count; end if;

  perform 1 from cron.job where jobname = 'hive-alert-evaluator' and schedule = '* * * * *';
  if not found then raise exception 'pg_cron job hive-alert-evaluator (every minute) missing'; end if;

  if has_function_privilege('anon', 'public.hive_alert_evaluator_record(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_alert_evaluator_record(jsonb)', 'EXECUTE') then
    raise exception 'hive_alert_evaluator_record is executable by client roles';
  end if;

  -- The same bar recorded twice yields one alert, and the rule's cooldown timestamp is set.
  insert into public.alert_rules (name, symbol, kind, params, cooldown_seconds)
  values ('verify-pct-rule', 'BTC', 'pct_move', '{"interval":"1m","lookback":10,"minAbsPct":1}', 600)
  returning id into v_rule;

  v_result := public.hive_alert_evaluator_record(jsonb_build_array(
    jsonb_build_object('dedup_key', 'rule:' || v_rule || ':1', 'rule_id', v_rule, 'symbol', 'BTC',
                       'kind', 'pct_move', 'severity', 'warning', 'payload', '{"pct": 1.5}'::jsonb),
    jsonb_build_object('dedup_key', 'rule:' || v_rule || ':1', 'rule_id', v_rule, 'symbol', 'BTC',
                       'kind', 'pct_move', 'severity', 'warning', 'payload', '{"pct": 1.5}'::jsonb)
  ));
  if (v_result->>'inserted')::integer <> 1 or (v_result->>'duplicates')::integer <> 1 then
    raise exception 'record RPC expected 1 insert and 1 duplicate, got %', v_result;
  end if;
  select last_triggered_at into v_last from public.alert_rules where id = v_rule;
  if v_last is null then raise exception 'record RPC did not set last_triggered_at'; end if;
  select count(*) into v_count from public.alerts where rule_id = v_rule;
  if v_count <> 1 then raise exception 'expected 1 alert for the verify rule, got %', v_count; end if;

  raise notice 'verify.sql: alert evaluation checks passed';
end
$$;

-- Yahoo collector: schedule, seeded rows, per-source lease, writes under source 'yahoo', and symbol mapping.
do $$
declare
  v_holder uuid := gen_random_uuid();
  v_count integer;
  v_price numeric;
  v_rows integer;
begin
  perform 1 from cron.job where jobname = 'hive-yahoo-collector' and schedule = '*/2 * * * *'
     and command like '%yahoo-collector%';
  if not found then raise exception 'pg_cron job hive-yahoo-collector (every 2 minutes, yahoo-collector) missing'; end if;

  perform 1 from public.collector_state where source = 'yahoo';
  if not found then raise exception 'collector_state has no yahoo row'; end if;
  perform 1 from public.source_health where source = 'yahoo' and max_staleness_minutes = 30 and enabled = false;
  if not found then raise exception 'source_health yahoo should be seeded disabled with 30 minutes staleness'; end if;

  if has_function_privilege('anon', 'public.hive_collector_upsert_candles(text,text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_collector_begin(text,uuid,integer)', 'EXECUTE') then
    raise exception 'yahoo collector RPCs must not be executable by client roles';
  end if;

  -- Lease is per source: the okx lease taken earlier does not block yahoo, and yahoo's own lease is exclusive.
  if not public.hive_collector_begin('yahoo', v_holder, 120) then raise exception 'yahoo lease should be granted while okx holds its lease'; end if;
  if public.hive_collector_begin('yahoo', gen_random_uuid(), 120) then raise exception 'yahoo lease granted while another run holds it'; end if;
  perform public.hive_collector_finish('yahoo', v_holder, 'ok', 0, '{"successes": 1}'::jsonb);
  if not public.hive_collector_begin('yahoo', gen_random_uuid(), 120) then raise exception 'yahoo lease should be free after finish'; end if;

  -- Quotes and candles land under source 'yahoo' and do not touch the okx rows.
  perform public.hive_collector_upsert_quote('VERIFY', 'yahoo', 55, 1000000002000);
  perform public.hive_collector_upsert_quote('VERIFY', 'yahoo', 54, 1000000001000);
  select price into v_price from public.quotes_latest where symbol = 'VERIFY' and source = 'yahoo';
  if v_price <> 55 then raise exception 'yahoo quote guard failed: expected 55, got %', v_price; end if;
  v_rows := public.hive_collector_upsert_candles('VERIFY', 'yahoo', '1D',
    '[{"ts":1000000000000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":10,"vol_ccy":0,"confirmed":true}]'::jsonb);
  if v_rows <> 1 then raise exception 'expected 1 yahoo daily candle written, got %', v_rows; end if;
  select count(*) into v_count from public.candles where symbol = 'VERIFY' and source = 'yahoo' and interval = '1D';
  if v_count <> 1 then raise exception 'yahoo daily candle not stored under source yahoo'; end if;

  -- Health: failure accumulates against yahoo only, and success resets it.
  perform public.hive_collector_record_failure('yahoo', 'probe failure');
  perform public.hive_collector_record_failure('yahoo', 'probe failure again');
  select consecutive_failures into v_count from public.source_health where source = 'yahoo';
  if v_count < 2 then raise exception 'yahoo consecutive_failures did not accumulate'; end if;
  perform public.hive_collector_record_success('yahoo');
  select consecutive_failures into v_count from public.source_health where source = 'yahoo';
  if v_count <> 0 then raise exception 'yahoo success did not reset source_health'; end if;

  -- Symbol mapping: every Yahoo-tracked symbol has a yahoo_symbol, and SKHY stays OKX-only.
  perform 1 from public.symbol_map
   where symbol in ('NVDA', 'BTC', 'XAU', 'BZ', 'ETH') and enabled and yahoo_symbol is not null;
  if not found then raise exception 'symbol_map is missing yahoo_symbol for a seeded symbol'; end if;
  perform 1 from public.symbol_map where symbol = 'SKHY' and yahoo_symbol is null;
  if not found then raise exception 'SKHY must keep a null yahoo_symbol (OKX-only)'; end if;

  -- Edge invoker: the yahoo job reaches the function once the Vault secrets from the news block exist.
  if public.hive_invoke_edge_function('yahoo-collector') is null then raise exception 'yahoo-collector invocation was not queued'; end if;

  raise notice 'verify.sql: yahoo collector checks passed';
end
$$;

-- ths-collector: schema additions, seeds, session gate, daily snapshot write path, prune, lease and schedules.
-- Uses VERIFYTHS keys and 1990s/1999 dates so nothing else is touched; the transaction rolls back at the end.
do $$
declare
  v_count integer;
  v_pruned integer;
  v_version integer;
  v_price numeric;
  v_expected integer;
  v_schedule text;
  v_command text;
  v_holder uuid := gen_random_uuid();
begin
  select count(*) into v_count from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'symbol_map' and column_name in ('ths_code', 'ths_kind', 'ths_auction'))
       or (table_name = 'source_health' and column_name = 'session_only'));
  if v_count <> 4 then raise exception 'ths columns missing (found %, expected 4)', v_count; end if;

  if to_regprocedure('public.hive_a_share_session_open(timestamptz)') is null
     or to_regprocedure('public.hive_collector_upsert_daily_snapshot(date,text,jsonb)') is null
     or to_regprocedure('public.hive_prune_ths_snapshots(integer)') is null then
    raise exception 'ths functions missing';
  end if;

  -- Seeds: documented thscodes only, disabled, auction opt-out.
  perform 1 from public.symbol_map
   where symbol = 'SH000001' and ths_code = '000001.SH' and ths_kind = 'index' and not enabled and not ths_auction;
  if not found then raise exception 'ths seed SH000001 missing or wrong'; end if;
  perform 1 from public.symbol_map
   where symbol = 'MOUTAI' and ths_code = '600519.SH' and ths_kind = 'stock' and not enabled and not ths_auction;
  if not found then raise exception 'ths seed MOUTAI missing or wrong'; end if;
  select count(*) into v_count from public.symbol_map
   where symbol in ('SH000001', 'SZ399001', 'SH000300', 'MOUTAI', 'WULIANGYE') and ths_code is not null and enabled;
  if v_count <> 0 then raise exception 'ths seeds must ship disabled (% enabled)', v_count; end if;

  -- Source switch: off, session-only, 10 minute staleness. collector_state row exists.
  perform 1 from public.source_health
   where source = 'ths' and not enabled and session_only and max_staleness_minutes = 10;
  if not found then raise exception 'source_health ths must be disabled, session_only, 10 minutes'; end if;
  perform 1 from public.collector_state where source = 'ths';
  if not found then raise exception 'collector_state row for ths missing'; end if;

  -- Constraints reject auction opt-in on an index, a malformed thscode, and a code without a kind.
  begin
    insert into public.symbol_map (symbol, enabled, ths_code, ths_kind, ths_auction)
    values ('VERIFYTHSIDX', false, '000001.SH', 'index', true);
    raise exception 'ths_auction on an index was accepted';
  exception when check_violation then
    if sqlerrm not like '%symbol_map_ths_auction_check%' then raise; end if;
  end;
  begin
    insert into public.symbol_map (symbol, enabled, ths_code, ths_kind)
    values ('VERIFYTHSBAD', false, '1234.SH', 'stock');
    raise exception 'malformed ths_code was accepted';
  exception when check_violation then
    if sqlerrm not like '%symbol_map_ths_code_format%' then raise; end if;
  end;
  begin
    insert into public.symbol_map (symbol, enabled, ths_code, ths_kind)
    values ('VERIFYTHSPAIR', false, '600519.SH', null);
    raise exception 'ths_code without ths_kind was accepted';
  exception when check_violation then
    if sqlerrm not like '%symbol_map_ths_pair_check%' then raise; end if;
  end;

  -- Session window in Asia/Shanghai, weekdays 09:15 inclusive to 15:15 exclusive.
  if not public.hive_a_share_session_open('2026-10-14T01:15:00Z') then raise exception 'session must open at 09:15 Beijing'; end if;
  if public.hive_a_share_session_open('2026-10-14T01:14:59Z') then raise exception 'session opened before 09:15 Beijing'; end if;
  if not public.hive_a_share_session_open('2026-10-14T07:14:59Z') then raise exception 'session closed too early at 15:14 Beijing'; end if;
  if public.hive_a_share_session_open('2026-10-14T07:15:00Z') then raise exception 'session must close at 15:15 Beijing'; end if;
  if public.hive_a_share_session_open('2026-10-17T02:00:00Z') then raise exception 'session must be closed on Saturday'; end if;

  -- Daily snapshot: one row per (date, kind), payload overwritten, non-ths kinds refused.
  perform public.hive_collector_upsert_daily_snapshot('1999-01-04', 'ths_verify', '{"v": 1}'::jsonb);
  perform public.hive_collector_upsert_daily_snapshot('1999-01-04', 'ths_verify', '{"v": 2}'::jsonb);
  select count(*), max(payload->>'v')::integer into v_count, v_version from public.daily_snapshot
   where snapshot_date = '1999-01-04' and kind = 'ths_verify';
  if v_count <> 1 or v_version <> 2 then raise exception 'daily snapshot upsert failed (rows %, v %)', v_count, v_version; end if;
  begin
    perform public.hive_collector_upsert_daily_snapshot('1999-01-04', 'okx_verify', '{}'::jsonb);
    raise exception 'daily snapshot accepted a non-ths kind';
  exception when others then
    if sqlerrm <> 'daily snapshot kind must start with ths_' then raise; end if;
  end;

  -- Prune removes old ths_ snapshots only.
  insert into public.daily_snapshot (snapshot_date, kind, payload) values
    ('1990-01-02', 'ths_verify_old', '{}'::jsonb),
    ('1990-01-02', 'verify_other_kind', '{}'::jsonb);
  v_pruned := public.hive_prune_ths_snapshots(30);
  if v_pruned < 1 then raise exception 'prune did not delete an old ths snapshot'; end if;
  perform 1 from public.daily_snapshot where snapshot_date = '1990-01-02' and kind = 'ths_verify_old';
  if found then raise exception 'prune kept an old ths snapshot'; end if;
  perform 1 from public.daily_snapshot where snapshot_date = '1990-01-02' and kind = 'verify_other_kind';
  if not found then raise exception 'prune deleted a non-ths snapshot'; end if;

  -- Quote path with source ths keeps the timestamp guard.
  perform public.hive_collector_upsert_quote('VERIFYTHS', 'ths', 100, 1000000000000);
  perform public.hive_collector_upsert_quote('VERIFYTHS', 'ths', 90, 999999999000);
  select price into v_price from public.quotes_latest where symbol = 'VERIFYTHS' and source = 'ths';
  if v_price <> 100 then raise exception 'ths quote guard failed: expected 100, got %', v_price; end if;

  -- Lease for ths is exclusive and releases on finish.
  if not public.hive_collector_begin('ths', v_holder, 90) then raise exception 'ths lease should be granted'; end if;
  if public.hive_collector_begin('ths', gen_random_uuid(), 90) then raise exception 'ths lease granted while held'; end if;
  perform public.hive_collector_finish('ths', v_holder, 'ok', 0, '{}'::jsonb);

  -- Health gate: an enabled ths source with no success opens a stale alert only while the session is open now and
  -- was open 10 minutes ago. Outside that window it stays quiet.
  update public.source_health set enabled = true, last_success_at = null, consecutive_failures = 0 where source = 'ths';
  perform public.hive_run_health_check();
  v_expected := case when public.hive_a_share_session_open(now())
                       and public.hive_a_share_session_open(now() - interval '10 minutes') then 1 else 0 end;
  select count(*) into v_count from public.alerts
   where kind = 'source_stale' and resolved_at is null and payload->>'source' = 'ths';
  if v_count <> v_expected then raise exception 'ths stale gating: expected % alerts, got %', v_expected, v_count; end if;

  -- Schedules: collector every two minutes in the UTC window, and the nightly prune.
  select schedule, command into v_schedule, v_command from cron.job where jobname = 'hive-ths-collector';
  if v_schedule is distinct from '*/2 1-7 * * 1-5' or v_command not like '%hive_invoke_edge_function(''ths-collector'')%' then
    raise exception 'pg_cron job hive-ths-collector missing or misconfigured (schedule %)', v_schedule;
  end if;
  select schedule into v_schedule from cron.job where jobname = 'hive-ths-prune';
  if v_schedule is distinct from '40 3 * * *' then raise exception 'pg_cron job hive-ths-prune missing or misconfigured'; end if;

  -- Only service_role may run the ths write paths.
  if has_function_privilege('anon', 'public.hive_collector_upsert_daily_snapshot(date,text,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_collector_upsert_daily_snapshot(date,text,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.hive_prune_ths_snapshots(integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_prune_ths_snapshots(integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.hive_a_share_session_open(timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_a_share_session_open(timestamptz)', 'EXECUTE') then
    raise exception 'ths functions executable by client roles';
  end if;
  if not has_function_privilege('service_role', 'public.hive_collector_upsert_daily_snapshot(date,text,jsonb)', 'EXECUTE') then
    raise exception 'service_role must execute the ths snapshot write path';
  end if;

  raise notice 'verify.sql: ths-collector checks passed';
end
$$;

-- order-submit: kill switch and demo limits are seeded, the intent insert is idempotent, and clients cannot reach any of it.
do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_count integer;
  v_status text;
  v_intent jsonb;
begin
  perform 1 from public.kill_switch where id = 1 and engaged = false;
  if not found then raise exception 'kill_switch row 1 must exist and be disengaged'; end if;

  perform 1 from public.risk_limits
   where mode = 'demo' and enabled and 'XAU-USDT-SWAP' = any (symbol_allowlist);
  if not found then raise exception 'demo risk_limits must allowlist XAU-USDT-SWAP'; end if;

  v_intent := jsonb_build_object(
    'intent_id', 'verify-intent-1', 'idempotency_key', 'verify-key-1', 'mode', 'demo', 'schema_version', 'okx.intent.v1',
    'action', 'open', 'source', 'verify', 'inst_id', 'XAU-USDT-SWAP', 'side', 'sell', 'pos_side', 'net', 'td_mode', 'isolated',
    'lever', 15, 'sz', 1, 'ord_type', 'market', 'reduce_only', false, 'sl_trigger_px', 4125, 'sl_ord_px', -1,
    'theme', 'verify', 'theme_stop_cap_u', 0.1, 'intent_created_at', now(), 'ttl_sec', 120,
    'cl_ord_id', 'verifyclordid000000000000000000001', 'request', '{}'::jsonb
  );
  v_first := public.hive_order_intent_insert(v_intent);
  if (v_first->>'inserted')::boolean is not true then raise exception 'first intent insert should insert'; end if;

  v_second := public.hive_order_intent_insert(v_intent || jsonb_build_object('intent_id', 'verify-intent-2'));
  if (v_second->>'inserted')::boolean then raise exception 'repeat idempotency_key must not insert again'; end if;
  if v_second->'row'->>'cl_ord_id' <> 'verifyclordid000000000000000000001' then
    raise exception 'repeat intent insert must return the stored row';
  end if;

  v_count := public.hive_order_submissions_since('demo', now() - interval '1 minute', 'some-other-key');
  if v_count < 1 then raise exception 'submissions_since should count the in-flight intent, got %', v_count; end if;
  v_count := public.hive_order_submissions_since('demo', now() - interval '1 minute', 'verify-key-1');
  if v_count <> 0 then raise exception 'submissions_since must exclude the caller key, got %', v_count; end if;

  perform public.hive_order_intent_finish('verify-key-1', jsonb_build_object('status', 'acked', 'ord_id', '123', 'detail', null));
  select status into v_status from public.order_intents where idempotency_key = 'verify-key-1';
  if v_status <> 'acked' then raise exception 'finish did not persist acked, got %', v_status; end if;

  perform public.hive_order_record(jsonb_build_object(
    'intent_id', 'verify-intent-1', 'mode', 'demo', 'action', 'open', 'kind', 'order', 'inst_id', 'XAU-USDT-SWAP',
    'side', 'sell', 'pos_side', 'net', 'ord_type', 'market', 'ord_id', '123',
    'cl_ord_id', 'verifyclordid000000000000000000001', 'sz', 1, 'state', 'accepted'
  ));
  perform public.hive_order_set_state('verifyclordid000000000000000000001', 'canceled');
  perform 1 from public.orders where cl_ord_id = 'verifyclordid000000000000000000001' and ord_id = '123' and state = 'canceled';
  if not found then raise exception 'orders upsert/set_state did not persist'; end if;

  begin
    perform public.hive_order_intent_finish('verify-key-1', jsonb_build_object('status', 'filled'));
    raise exception 'an unknown intent status was accepted';
  exception when check_violation then
    null;
  end;

  if has_table_privilege('anon', 'public.order_intents', 'SELECT')
     or has_table_privilege('authenticated', 'public.orders', 'SELECT')
     or has_table_privilege('authenticated', 'public.risk_limits', 'SELECT') then
    raise exception 'anon/authenticated must not read order tables';
  end if;
  if has_function_privilege('anon', 'public.hive_order_intent_insert(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_order_record(jsonb)', 'EXECUTE') then
    raise exception 'order RPCs executable by client roles';
  end if;
  if not has_function_privilege('service_role', 'public.hive_order_intent_insert(jsonb)', 'EXECUTE') then
    raise exception 'service_role must execute the order intent insert';
  end if;

  raise notice 'verify.sql: order-submit checks passed';
end
$$;

-- Webhook priority: policy, critical-first claim, bulk expiry, stale event_ts, release and the dispatcher kick.
-- Runs last. It marks every other pending delivery as delivered so the claims below see only its own rows.
do $$
declare
  v_sub uuid;
  v_policy record;
  v_before integer;
  v_after integer;
  v_claim record;
  v_bulk_delivery bigint;
  v_price_delivery bigint;
  v_fill_delivery bigint;
  v_expiring_delivery bigint;
  v_fill_ts timestamptz := now() - interval '2 minutes';
  v_seen_bulk boolean := false;
  v_count integer;
  v_status text;
  v_attempts integer;
begin
  -- The whole file is one transaction, so the kick dedupe flag set by earlier checks must be cleared here.
  perform set_config('hive.webhook_kick_queued', 'off', true);

  select * into v_policy from public.hive_delivery_policy('alert', 'fill');
  if v_policy.priority <> 'critical' or v_policy.stale_after_seconds <> 60 or v_policy.expires_after_seconds is not null then
    raise exception 'fill policy mismatch';
  end if;
  select * into v_policy from public.hive_delivery_policy('alert', 'volume_spike');
  if v_policy.priority <> 'bulk' or v_policy.expires_after_seconds <> 900 then raise exception 'volume_spike must be bulk with a 900 s expiry'; end if;
  select * into v_policy from public.hive_delivery_policy('news', null);
  if v_policy.priority <> 'critical' or v_policy.expires_after_seconds is not null then raise exception 'news must be critical and never expire'; end if;

  delete from vault.secrets where name in ('edge_base_url', 'edge_cron_secret');
  perform vault.create_secret('http://127.0.0.1:9/functions/v1', 'edge_base_url', 'verify');
  perform vault.create_secret('verify-edge-secret', 'edge_cron_secret', 'verify');

  v_sub := public.hive_upsert_webhook_subscription(null, 'verify-prio-agent', 'https://prio.example.com/hook',
    'verify-prio-secret-0123456789abcdef', array['alert'], '{}', true);

  -- Kick: a bulk alert queues none; the first critical alert queues one; a second critical in the same transaction queues none.
  select count(*) into v_before from net.http_request_queue where url like '%/webhook-dispatcher';
  insert into public.alerts (dedup_key, kind, symbol, severity, payload)
  values ('verify-prio-bulk', 'volume_spike', 'ETH', 'warning', '{"volume": 12}');
  select count(*) into v_after from net.http_request_queue where url like '%/webhook-dispatcher';
  if v_after <> v_before then raise exception 'a bulk alert must not kick the dispatcher'; end if;

  insert into public.alerts (dedup_key, kind, symbol, severity, payload)
  values ('verify-prio-price', 'price_cross', 'BTC', 'critical', '{"price": 91000}');
  select count(*) into v_after from net.http_request_queue where url like '%/webhook-dispatcher';
  if v_after - v_before <> 1 then raise exception 'a critical alert must queue exactly one dispatcher kick (queued %)', v_after - v_before; end if;
  v_before := v_after;

  insert into public.alerts (dedup_key, kind, symbol, severity, payload)
  values ('verify-prio-fill', 'fill', 'BTC', 'critical', jsonb_build_object('event_ts', v_fill_ts));
  select count(*) into v_after from net.http_request_queue where url like '%/webhook-dispatcher';
  if v_after <> v_before then raise exception 'a second critical alert in one transaction must not queue another kick'; end if;

  select d.id into v_bulk_delivery from public.webhook_deliveries d join public.alerts a on d.event_key = 'alert:' || a.id
   where a.dedup_key = 'verify-prio-bulk' and d.subscription_id = v_sub;
  select d.id into v_price_delivery from public.webhook_deliveries d join public.alerts a on d.event_key = 'alert:' || a.id
   where a.dedup_key = 'verify-prio-price' and d.subscription_id = v_sub;
  select d.id into v_fill_delivery from public.webhook_deliveries d join public.alerts a on d.event_key = 'alert:' || a.id
   where a.dedup_key = 'verify-prio-fill' and d.subscription_id = v_sub;
  if v_bulk_delivery is null or v_price_delivery is null or v_fill_delivery is null then raise exception 'priority alerts were not fanned out'; end if;

  perform 1 from public.webhook_deliveries d
   where d.id = v_bulk_delivery and d.priority = 'bulk' and d.stale_after_seconds = 300 and d.expires_at is not null;
  if not found then raise exception 'bulk delivery must carry bulk priority, a 300 s stale threshold and an expiry'; end if;
  perform 1 from public.webhook_deliveries d
   where d.id = v_price_delivery and d.priority = 'critical' and d.stale_after_seconds = 120 and d.expires_at is null;
  if not found then raise exception 'critical delivery must carry critical priority, a 120 s stale threshold and no expiry'; end if;
  perform 1 from public.webhook_deliveries d
   where d.id = v_fill_delivery and d.event_ts = v_fill_ts and d.stale_after_seconds = 60;
  if not found then raise exception 'fill delivery must keep the event_ts from its payload'; end if;

  -- Only this subscription's rows are claimable from here on.
  update public.webhook_deliveries set status = 'delivered', delivered_at = now()
   where status = 'pending' and subscription_id <> v_sub;

  -- Critical first: the bulk row was inserted first and is due, yet the first claim returns a critical row.
  select * into v_claim from public.hive_webhook_claim(1, 120) c;
  if v_claim.priority <> 'critical' or v_claim.delivery_id not in (v_price_delivery, v_fill_delivery) then
    raise exception 'claim returned % before critical deliveries', v_claim.priority;
  end if;
  if v_claim.delivery_id = v_fill_delivery and v_claim.event_ts <> v_fill_ts then
    raise exception 'claim did not return the event_ts of a critical delivery';
  end if;

  -- The rest is claimed critical-first as well.
  v_count := 0;
  for v_claim in select * from public.hive_webhook_claim(10, 120) c loop
    v_count := v_count + 1;
    if v_claim.priority = 'bulk' then
      v_seen_bulk := true;
    elsif v_seen_bulk then
      raise exception 'a critical delivery was claimed after a bulk one';
    end if;
  end loop;
  if v_count <> 2 then raise exception 'expected the 2 remaining deliveries to be claimed, got %', v_count; end if;

  -- A release refunds the attempt that the claim counted and returns the row to pending.
  select attempts into v_attempts from public.webhook_deliveries where id = v_bulk_delivery;
  if v_attempts <> 1 then raise exception 'claimed bulk row should have attempts 1, got %', v_attempts; end if;
  if public.hive_webhook_release(array[v_bulk_delivery]) <> 1 then raise exception 'release did not return the claimed row'; end if;
  select status, attempts into v_status, v_attempts from public.webhook_deliveries where id = v_bulk_delivery;
  if v_status <> 'pending' or v_attempts <> 0 then raise exception 'released row should be pending with 0 attempts (got % / %)', v_status, v_attempts; end if;
  if public.hive_webhook_release(array[v_bulk_delivery]) <> 0 then raise exception 'release must only touch sending rows'; end if;

  -- A bulk row past expires_at is expired and never leased, even though it is due.
  insert into public.alerts (dedup_key, kind, symbol, severity, payload)
  values ('verify-prio-expiring', 'pct_move', 'SNDK', 'warning', '{}');
  update public.webhook_deliveries set status = 'delivered', delivered_at = now()
   where status = 'pending' and subscription_id <> v_sub;
  select d.id into v_expiring_delivery from public.webhook_deliveries d join public.alerts a on d.event_key = 'alert:' || a.id
   where a.dedup_key = 'verify-prio-expiring' and d.subscription_id = v_sub;
  update public.webhook_deliveries set expires_at = now() - interval '1 second' where id = v_expiring_delivery;
  select count(*) into v_count from public.hive_webhook_claim(10, 120) c where c.delivery_id = v_expiring_delivery;
  if v_count <> 0 then raise exception 'an expired bulk delivery was claimed'; end if;
  select status into v_status from public.webhook_deliveries where id = v_expiring_delivery;
  if v_status <> 'expired' then raise exception 'expired bulk delivery should be marked expired, got %', v_status; end if;

  -- Only service_role may run the release and policy functions.
  if has_function_privilege('anon', 'public.hive_webhook_release(bigint[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_webhook_release(bigint[])', 'EXECUTE')
     or has_function_privilege('anon', 'public.hive_delivery_policy(text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hive_delivery_policy(text,text)', 'EXECUTE') then
    raise exception 'webhook release or policy function executable by client roles';
  end if;

  raise notice 'verify.sql: webhook priority checks passed';
end
$$;

rollback;
