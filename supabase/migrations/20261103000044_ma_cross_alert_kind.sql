-- Allow the ma_cross rule kind for the alert-evaluator.
--
-- ma_cross fires when the latest confirmed intraday bar closes across the
-- moving average of the last `period` completed daily closes from the same
-- source's 1D series (see packages/core/src/alerts.ts evaluateMaCross).
-- The evaluator reads the daily series alongside the intraday one, so no
-- other schema change is needed: the alerts dedup key (rule_id, bar_ts)
-- already gives one alert per rule per bar, and cooldown_seconds on the
-- rule row bounds repeats when the price whipsaws around the average.
--
-- The constraint is named alert_rules_kind_check since migration
-- 20261013000021 (it replaced the original inline, unnamed check), so it
-- can be dropped and re-added directly. This migration only widens the
-- allowed kinds; it inserts no rule row, because alert_rules.symbol
-- references symbol_map -- the production row for 亨通光电 is HTGD
-- (ths_code 600487.SH), and the rule insert is a deploy-time step.
alter table public.alert_rules drop constraint if exists alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('price_cross', 'candle_close_break', 'volume_spike', 'long_wick', 'pullback', 'pct_move', 'ma_cross'));
