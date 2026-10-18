-- Migration 31: webhook delivery policy — conditional-order outcomes are critical.
--
-- Codex PR #30 (P2): strategy-evaluator inserts alerts with severity 'critical', but webhook
-- fan-out priority comes from hive_delivery_policy(event_type, kind), whose critical-kind list
-- predates conditional orders. Without this, conditional_order_fired / conditional_order_failed
-- fan out as bulk (300s stale threshold, 900s expiry, no immediate dispatcher kick). Classify both
-- like the other critical alert kinds: critical priority, 120s stale threshold, no expiry.
--
-- Based on the current definition as last replaced by migration 20261014000027 (which added
-- 'earnings_guidance'); the search_path pin from migration 20261016000028 is re-asserted because
-- CREATE OR REPLACE does not preserve per-function settings.

create or replace function public.hive_delivery_policy(p_event_type text, p_kind text)
returns table (priority text, stale_after_seconds integer, expires_after_seconds integer)
language sql
immutable
as $$
  select
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                         'earnings_guidance', 'conditional_order_fired', 'conditional_order_failed')
         then 'critical' else 'bulk' end,
    case when p_kind = 'fill' then 60
         when p_event_type = 'alert'
           and p_kind in ('near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                          'earnings_guidance', 'conditional_order_fired', 'conditional_order_failed') then 120
         else 300 end,
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross',
                         'earnings_guidance', 'conditional_order_fired', 'conditional_order_failed')
         then null else 900 end
$$;

alter function public.hive_delivery_policy(text, text) set search_path = public;

revoke all on function public.hive_delivery_policy(text, text) from public, anon, authenticated;
