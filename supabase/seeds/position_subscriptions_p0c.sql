-- P0c post-deploy seed: the two live in-position subscriptions agreed with Grok on 2026-10-14.
-- Apply after migrations and the position-manager / position-subscriptions deploy:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/seeds/position_subscriptions_p0c.sql
--
-- Both rows: mode=live, half_reduce_done=false on first insert, theme_stop_cap_u=0.1, lever=15, td_mode=isolated, enabled.
-- Re-running is safe. The upsert updates the enabled row in place and keeps half_reduce_done, so a second run can never
-- trigger a second reduce. Do NOT add reset_state here; reset_state=true is the only path that clears half_reduce_done.
--
-- No symbol allowlist applies to position management. QQQ-USDT-SWAP is subscribed the same way as BTC-USDT-SWAP.
-- Each row still goes through kill_switch, theme_stop_cap_u <= 0.1, and the order-submit risk checks.

select public.hive_position_subscription_upsert('{
  "mode": "live",
  "inst_id": "BTC-USDT-SWAP",
  "pos_side": "net",
  "direction": "short",
  "td_mode": "isolated",
  "lever": 15,
  "entry_px": 81818.5,
  "sl_px": 82700,
  "tp_px": 80400,
  "mid_px": 82259.25,
  "theme_stop_cap_u": 0.1,
  "atr_len": 14,
  "atr_mult": 0.8,
  "amend_min_atr_frac": 0.15,
  "half_reduce_frac": 0.5,
  "dynamic_tp_enabled": true,
  "half_reduce_enabled": true,
  "enabled": true,
  "note": "Grok seed 2026-10-14: BTC short/net, P0c"
}'::jsonb);

select public.hive_position_subscription_upsert('{
  "mode": "live",
  "inst_id": "QQQ-USDT-SWAP",
  "pos_side": "net",
  "direction": "long",
  "td_mode": "isolated",
  "lever": 15,
  "entry_px": 731.19,
  "sl_px": 721,
  "tp_px": 741,
  "mid_px": 726.095,
  "theme_stop_cap_u": 0.1,
  "atr_len": 14,
  "atr_mult": 0.8,
  "amend_min_atr_frac": 0.15,
  "half_reduce_frac": 0.5,
  "dynamic_tp_enabled": true,
  "half_reduce_enabled": true,
  "enabled": true,
  "note": "Grok seed 2026-10-14: QQQ long/net, P0c"
}'::jsonb);
