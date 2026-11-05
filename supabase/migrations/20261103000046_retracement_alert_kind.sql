-- Allow the retracement rule kind and seed the XAU / crude turning-point rules with their Telegram subscriptions.
--
-- retracement is a turning-point signal, not a trade instruction. The anchor is the highest high (top) or
-- lowest low (bottom) of the trailing `lookback` confirmed bars, excluding the bar being judged; the rule fires
-- when the latest close has already given back `minRetracePct` percent from that anchor (see
-- packages/core/src/alerts.ts evaluateRetracement). cooldown_seconds bounds repeats, and the alerts dedup key
-- already gives one alert per rule per bar, so no other schema change is needed.
--
-- The constraint is named alert_rules_kind_check since migration 20261013000021, so it can be dropped and
-- re-added directly. Additive and idempotent: no existing rule or subscription is touched, and the inserts are
-- guarded so a re-run is a no-op.
alter table public.alert_rules drop constraint if exists alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('price_cross', 'candle_close_break', 'volume_spike', 'long_wick', 'pullback', 'pct_move',
                  'ma_cross', 'retracement'));

-- 15m turning points: 20-bar anchor, 0.3% retracement, 30-minute cooldown. XAU and the two crude symbols already
-- exist in symbol_map with live OKX swaps (XAU-USDT-SWAP, CL-USDT-SWAP, BZ-USDT-SWAP) and the collector writes
-- their confirmed 15m bars, so no symbol or feed change is needed here.
insert into public.alert_rules (name, symbol, source, kind, params, cooldown_seconds, enabled)
select v.name, v.symbol, 'okx', 'retracement',
       '{"interval":"15m","lookback":20,"minRetracePct":0.3,"side":"both"}'::jsonb, 1800, true
  from (values
    ('XAU 15m turning point 0.3%', 'XAU'),
    ('CL 15m turning point 0.3%', 'CL'),
    ('BZ 15m turning point 0.3%', 'BZ')
  ) as v(name, symbol)
 where not exists (
   select 1 from public.alert_rules r
    where r.kind = 'retracement' and r.symbol = v.symbol and r.name = v.name
 );

-- Telegram subscriptions on the same chat as xau-volume, filtered to the matching symbol and kind only, so they
-- reuse the existing telegram-dispatcher path without widening xau-volume. The bot token is not written here:
-- the rows copy the Vault secret_id of the existing xau-volume subscription, which upsert-seeds it, and fall back
-- to hive_upsert_telegram_subscription (token supplied out of band) when that subscription is missing.
do $$
declare
  v_source public.telegram_subscriptions%rowtype;
  v_spec record;
begin
  select * into v_source from public.telegram_subscriptions where name = 'xau-volume';
  if not found then
    raise notice 'xau-volume subscription missing; seed it before this migration to copy its bot token';
  end if;

  for v_spec in
    select * from (values ('xau-retracement', 'XAU'), ('cl-retracement', 'CL'), ('bz-retracement', 'BZ'))
      as t(name, symbol)
  loop
    if exists (select 1 from public.telegram_subscriptions s where s.name = v_spec.name) then
      continue;
    end if;
    if v_source.id is null or v_source.secret_id is null then
      raise notice 'skipping %: no xau-volume bot token to copy', v_spec.name;
      continue;
    end if;
    insert into public.telegram_subscriptions (name, chat_id, secret_id, event_types, filters, enabled)
    values (v_spec.name, v_source.chat_id, v_source.secret_id, array['alert']::text[],
            jsonb_build_object('symbols', jsonb_build_array(v_spec.symbol),
                               'alert_kinds', jsonb_build_array('retracement')),
            true);
  end loop;
end
$$;
