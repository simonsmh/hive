-- Add the SZ159915 (创业板 ETF 易方达) 15m retracement turning-point rule.
--
-- Same caliber as the XAU / CL / BZ retracement rules (migration
-- 20261103000046): 15m bars, anchor = highest high / lowest low of the
-- trailing 20 bars, fires when the latest close has given back 0.3% from
-- the anchor, both directions, edge-triggered, 30-minute cooldown, Telegram
-- delivery. Approved by the user 2026-11-05 evening.
--
-- The 15m series is new for A-shares: the sina-intraday-collector now
-- aggregates 15m bars from its complete confirmed 5m windows, so the
-- evaluator reads them from the candles table exactly like the OKX 15m
-- series. The symbol_map row must exist first: alert_rules.symbol
-- references symbol_map, and the collector only polls symbols that are
-- both in symbol_map (enabled, with ths_code) and on its hard-coded
-- whitelist (SZ159915 was added there in the same change).
insert into public.symbol_map (symbol, ths_code, ths_kind, ths_auction, enabled)
values ('SZ159915', '159915.SZ', 'stock', false, true)
on conflict (symbol) do update set ths_code = excluded.ths_code, ths_kind = excluded.ths_kind, enabled = true;

insert into public.alert_rules (name, symbol, source, kind, params, cooldown_seconds, enabled)
select 'SZ159915 15m turning point 0.3%', 'SZ159915', 'sina', 'retracement',
       '{"interval":"15m","lookback":20,"minRetracePct":0.3,"side":"both"}'::jsonb, 1800, true
 where not exists (
   select 1 from public.alert_rules r
    where r.kind = 'retracement' and r.symbol = 'SZ159915' and r.name = 'SZ159915 15m turning point 0.3%'
 );

-- Telegram subscription on the same chat as xau-retracement, filtered to this
-- symbol and kind only, so it reuses the existing telegram-dispatcher path.
-- The bot token is not written here: the row copies the Vault secret_id of
-- the existing xau-retracement subscription.
do $$
declare
  v_source public.telegram_subscriptions%rowtype;
begin
  select * into v_source from public.telegram_subscriptions where name = 'xau-retracement';
  if not found then
    raise notice 'xau-retracement subscription missing; seed it before this migration to copy its bot token';
    return;
  end if;
  if exists (select 1 from public.telegram_subscriptions s where s.name = 'sz159915-retracement') then
    return;
  end if;
  if v_source.id is null or v_source.secret_id is null then
    raise notice 'skipping sz159915-retracement: no xau-retracement bot token to copy';
    return;
  end if;
  insert into public.telegram_subscriptions (name, chat_id, secret_id, event_types, filters, enabled)
  values ('sz159915-retracement', v_source.chat_id, v_source.secret_id, array['alert']::text[],
          jsonb_build_object('symbols', jsonb_build_array('SZ159915'),
                             'alert_kinds', jsonb_build_array('retracement')),
          true);
end
$$;
