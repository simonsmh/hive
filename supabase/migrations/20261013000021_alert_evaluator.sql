-- Production evaluation of alert_rules. The alert-evaluator Edge Function reads enabled rules and confirmed
-- candles over PostgREST, applies cooldown and bar freshness in code, and writes matches through
-- hive_alert_evaluator_record. Inserts into alerts fire alerts_fanout, so webhook delivery stays on the existing
-- path (alerts -> webhook_deliveries -> webhook-dispatcher) and the evaluator never calls a webhook itself.
-- Additive and idempotent: safe to re-run, and it never overwrites a rule or symbol that already exists.

-- 1) Allow the pct_move kind. The original check was declared inline without a name, so Postgres called it
--    alert_rules_kind_check.
alter table public.alert_rules drop constraint if exists alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('price_cross', 'candle_close_break', 'volume_spike', 'long_wick', 'pullback', 'pct_move'));

-- 2) SKHY is tracked by hand in production. Keep the existing row and only make sure it is enabled. A null
--    okx_inst_id lets the collector resolve the OKX instrument on its next run.
insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol, enabled)
values ('SKHY', null, null, true)
on conflict (symbol) do update set enabled = true, updated_at = now();

-- 3) Stock storage watch: 10 one-minute bars (the 10-minute cadence Stock polled at) and a move of at least 1%.
--    cooldown_seconds 600 lets an alert repeat at most once per 10 minutes while the move persists.
insert into public.alert_rules (name, symbol, source, kind, params, cooldown_seconds, enabled)
select v.name, v.symbol, 'okx', 'pct_move', '{"interval":"1m","lookback":10,"minAbsPct":1}'::jsonb, 600, true
  from (values
    ('SNDK 10m move >=1%', 'SNDK'),
    ('MU 10m move >=1%', 'MU'),
    ('SKHY 10m move >=1%', 'SKHY')
  ) as v(name, symbol)
 where not exists (
   select 1 from public.alert_rules r
    where r.kind = 'pct_move' and r.symbol = v.symbol and r.name = v.name
 );

-- Writes evaluator matches. Each item is {dedup_key, rule_id, symbol, kind, severity, payload}. A dedup_key that
-- already exists is skipped (alerts.dedup_key is unique), so a bar triggers at most once per rule even when runs
-- overlap. last_triggered_at is set only for rows actually inserted, which is what the cooldown reads.
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
begin
  for v_item in select value from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) loop
    v_rule_id := nullif(v_item->>'rule_id', '')::uuid;
    v_id := null;

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
        update public.alert_rules set last_triggered_at = now(), updated_at = now() where id = v_rule_id;
      end if;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_duplicates);
end
$$;

revoke execute on function public.hive_alert_evaluator_record(jsonb) from public, anon, authenticated;
grant execute on function public.hive_alert_evaluator_record(jsonb) to service_role;
grant select on public.alert_rules, public.candles to service_role;

-- 4) Schedule. Every minute matches the 1m bar cadence: the evaluator only has new data when a bar confirms, and
--    dedup keys are per bar, so a 30-second schedule would repeat the same evaluation with no extra signal.
--    The Edge invocation budget stays comfortably under the free-tier monthly limit (1,440 runs per day).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-alert-evaluator') then
    perform cron.unschedule('hive-alert-evaluator');
  end if;
end
$$;

select cron.schedule('hive-alert-evaluator', '* * * * *', $$select public.hive_invoke_edge_function('alert-evaluator')$$);
