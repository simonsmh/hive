-- order-submit gains an adjust_margin action: add margin to an existing position without
-- placing an order (OKX POST /api/v5/account/adjust-position-margin, type='add' only).
-- order_intents.action is guarded by a CHECK constraint, so the new action has to be
-- admitted here before any adjust_margin intent can be recorded.

alter table public.order_intents drop constraint order_intents_action_check;

alter table public.order_intents add constraint order_intents_action_check
  check (action = any (array['open'::text, 'close'::text, 'amend_tpsl'::text, 'reduce'::text, 'set_leverage'::text, 'adjust_margin'::text]));
