-- Independent XAUUSD spot snapshot source (gold-api.com official /price/XAU
-- USD endpoint) and a one-shot snapshot_cross watch at 3720 USD/troy oz.
-- Does not write 1m candles, does not touch OKX XAU perpetual collection,
-- trading switches, news, or existing A-share alert rules.

alter table public.alert_rules
  add column if not exists last_quote_price numeric,
  add column if not exists last_quote_ts timestamptz;

alter table public.alert_rules drop constraint if exists alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in (
    'price_cross',
    'candle_close_break',
    'volume_spike',
    'long_wick',
    'pullback',
    'pct_move',
    'ma_cross',
    'retracement',
    'price_run',
    'snapshot_cross'
  ));

insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol, enabled)
values ('XAUUSD', null, null, true)
on conflict (symbol) do update
   set enabled = true,
       updated_at = now()
 where public.symbol_map.okx_inst_id is null
   and public.symbol_map.yahoo_symbol is null;

insert into public.source_health (source, enabled, max_staleness_minutes, session_only)
values ('gold-api', true, 10, false)
on conflict (source) do update
   set enabled = true,
       max_staleness_minutes = excluded.max_staleness_minutes,
       session_only = false,
       updated_at = now();

create or replace function public.hive_alert_evaluator_observe_quote(
  p_rule_id uuid,
  p_price numeric,
  p_ts_ms bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_rule_id is null or p_price is null or p_ts_ms is null then
    raise exception 'observe_quote requires rule id, price and ts';
  end if;
  if p_price <= 0 or not (p_price = p_price) then
    raise exception 'observe_quote price must be a finite number greater than 0';
  end if;
  update public.alert_rules
     set last_quote_price = p_price,
         last_quote_ts = to_timestamp(p_ts_ms::double precision / 1000),
         updated_at = now()
   where id = p_rule_id
     and enabled
     and (last_quote_ts is null or last_quote_ts < to_timestamp(p_ts_ms::double precision / 1000));
end
$$;

revoke execute on function public.hive_alert_evaluator_observe_quote(uuid, numeric, bigint) from public, anon, authenticated;
grant execute on function public.hive_alert_evaluator_observe_quote(uuid, numeric, bigint) to service_role;

create or replace function public.hive_alert_evaluator_record(p_alerts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_item jsonb;
  v_rule_id uuid;
  v_id bigint;
  v_inserted integer := 0;
  v_duplicates integer := 0;
  v_disable boolean;
begin
  for v_item in select value from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) loop
    v_rule_id := nullif(v_item->>'rule_id', '')::uuid;
    v_id := null;
    v_disable := coalesce((v_item->>'disable_rule')::boolean, false);

    insert into public.alerts (dedup_key, rule_id, symbol, kind, severity, payload)
    values (v_item->>'dedup_key', v_rule_id, v_item->>'symbol', v_item->>'kind',
            coalesce(v_item->>'severity', 'warning'), coalesce(v_item->'payload', '{}'::jsonb))
    on conflict (dedup_key) do nothing
    returning id into v_id;

    if v_id is null then
      v_duplicates := v_duplicates + 1;
    else
      v_inserted := v_inserted + 1;
      if v_rule_id is not null then
        update public.alert_rules
           set last_triggered_at = now(),
               updated_at = now(),
               enabled = case when v_disable then false else enabled end,
               last_quote_price = coalesce((v_item->'payload'->>'last_price')::numeric, last_quote_price),
               last_quote_ts = coalesce((v_item->'payload'->>'quote_ts')::timestamptz, last_quote_ts)
         where id = v_rule_id;
      end if;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_duplicates);
end
$$;

-- Keep production's critical-kind list and add snapshot_cross beside price_cross
-- so a one-shot level break is claimed promptly and is not expired as bulk.
create or replace function public.hive_delivery_policy(p_event_type text, p_kind text)
returns table(priority text, stale_after_seconds integer, expires_after_seconds integer)
language sql
immutable
set search_path = public
as $$
  select
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                         'snapshot_cross',
                         'earnings_guidance', 'conditional_order_fired', 'conditional_order_failed')
         then 'critical' else 'bulk' end,
    case when p_kind = 'fill' then 60
         when p_event_type = 'alert'
           and p_kind in ('near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                          'snapshot_cross',
                          'earnings_guidance', 'conditional_order_fired', 'conditional_order_failed') then 120
         else 300 end,
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                         'snapshot_cross',
                         'earnings_guidance', 'conditional_order_fired', 'conditional_order_failed')
         then null else 900 end
$$;

revoke all on function public.hive_delivery_policy(text, text) from public, anon, authenticated;
grant execute on function public.hive_delivery_policy(text, text) to service_role;

insert into public.alert_rules (name, symbol, source, kind, params, cooldown_seconds, enabled)
select
  'XAUUSD gold-api spot snapshot <= 3720 USD/oz, once',
  'XAUUSD',
  'gold-api',
  'snapshot_cross',
  '{"level":3720,"direction":"below","once":true,"maxQuoteAgeSeconds":480}'::jsonb,
  0,
  true
 where not exists (
   select 1 from public.alert_rules r
    where r.kind = 'snapshot_cross'
      and r.symbol = 'XAUUSD'
      and r.source = 'gold-api'
      and r.name = 'XAUUSD gold-api spot snapshot <= 3720 USD/oz, once'
 );

update public.webhook_subscriptions
   set filters = jsonb_set(
     jsonb_set(
       filters,
       '{alert_kinds}',
       (
         select coalesce(jsonb_agg(to_jsonb(k) order by k), '[]'::jsonb)
           from (
             select distinct k
               from jsonb_array_elements_text(coalesce(filters->'alert_kinds', '[]'::jsonb)) as t(k)
             union
             select 'snapshot_cross'
           ) s
       )
     ),
     '{symbols}',
     (
       select coalesce(jsonb_agg(to_jsonb(s) order by s), '[]'::jsonb)
         from (
           select distinct s
             from jsonb_array_elements_text(coalesce(filters->'symbols', '[]'::jsonb)) as t(s)
           union
           select 'XAUUSD'
         ) q
     )
   )
 where agent_name = 'grokbot-market'
   and (
     not coalesce(filters->'alert_kinds', '[]'::jsonb) ? 'snapshot_cross'
     or not coalesce(filters->'symbols', '[]'::jsonb) ? 'XAUUSD'
   );

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'hive-gold-api-collector') then
      perform cron.unschedule('hive-gold-api-collector');
    end if;
    perform cron.schedule(
      'hive-gold-api-collector',
      '*/2 * * * *',
      $cron$select public.hive_invoke_edge_function('gold-api-collector')$cron$
    );
  else
    raise notice 'pg_cron not installed, skipping hive-gold-api-collector schedule';
  end if;
end
$$;
