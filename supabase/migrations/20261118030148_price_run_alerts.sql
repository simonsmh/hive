-- Migration: add the price_run alert kind for session-contiguous 5m structure
-- on SH000688 / SZ399006 / SH000300, independent of volume_spike.
--
-- Production alert_rules_kind_check already includes ma_cross and retracement
-- (ahead of origin/main). Recreate it with those kinds plus price_run.
-- hive_delivery_policy's ELSE branch already classifies unknown market kinds
-- as bulk / 300s stale / 900s expiry, the same as volume_spike / ma_cross /
-- retracement / pct_move. price_run is intentionally left on that path; this
-- migration does not rewrite the function (production body is ahead of some
-- repo copies) and must not be smuggled in as volume_spike or pct_move.
--
-- grokbot-market keeps its symbol list and gains price_run in alert_kinds.
-- grokbot-news is not modified. Trading tables are not touched.

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
    'price_run'
  ));

insert into public.alert_rules (name, symbol, source, kind, params, cooldown_seconds, enabled)
select v.name, v.symbol, 'sina', 'price_run', v.params, 1800, true
  from (values
    (
      'SH000688 5m price_run up, 4 bars, 0.8%, skip open/lunch',
      'SH000688',
      '{"interval":"5m","minBars":4,"minMovePct":0.8,"side":"up","skipSessionOpenBars":1,"maxBarShare":0.7}'::jsonb
    ),
    (
      'SH000688 5m price_run down, 4 bars, 0.8%, skip open/lunch',
      'SH000688',
      '{"interval":"5m","minBars":4,"minMovePct":0.8,"side":"down","skipSessionOpenBars":1,"maxBarShare":0.7}'::jsonb
    ),
    (
      'SZ399006 5m price_run up, 4 bars, 0.8%, skip open/lunch',
      'SZ399006',
      '{"interval":"5m","minBars":4,"minMovePct":0.8,"side":"up","skipSessionOpenBars":1,"maxBarShare":0.7}'::jsonb
    ),
    (
      'SZ399006 5m price_run down, 4 bars, 0.8%, skip open/lunch',
      'SZ399006',
      '{"interval":"5m","minBars":4,"minMovePct":0.8,"side":"down","skipSessionOpenBars":1,"maxBarShare":0.7}'::jsonb
    ),
    (
      'SH000300 5m price_run up, 4 bars, 0.8%, skip open/lunch',
      'SH000300',
      '{"interval":"5m","minBars":4,"minMovePct":0.8,"side":"up","skipSessionOpenBars":1,"maxBarShare":0.7}'::jsonb
    ),
    (
      'SH000300 5m price_run down, 4 bars, 0.8%, skip open/lunch',
      'SH000300',
      '{"interval":"5m","minBars":4,"minMovePct":0.8,"side":"down","skipSessionOpenBars":1,"maxBarShare":0.7}'::jsonb
    )
  ) as v(name, symbol, params)
 where not exists (
   select 1 from public.alert_rules r
    where r.kind = 'price_run' and r.symbol = v.symbol and r.name = v.name
 );

update public.webhook_subscriptions
   set filters = jsonb_set(
     filters,
     '{alert_kinds}',
     (
       select coalesce(jsonb_agg(to_jsonb(k) order by k), '[]'::jsonb)
         from (
           select distinct k
             from jsonb_array_elements_text(coalesce(filters->'alert_kinds', '[]'::jsonb)) as t(k)
           union
           select 'price_run'
         ) s
     )
   )
 where agent_name = 'grokbot-market'
   and not coalesce(filters->'alert_kinds', '[]'::jsonb) ? 'price_run';
