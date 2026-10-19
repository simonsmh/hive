-- order-submit gains a set_leverage action: adjust the leverage of an existing position without
-- placing an order (previously the only way to change leverage was to close and reopen, because
-- setLeverage was only ever called as a prelude to an open). order_intents.action is guarded by a
-- CHECK constraint, so the new action has to be admitted here before any set_leverage intent can
-- be recorded.

alter table public.order_intents drop constraint order_intents_action_check;

alter table public.order_intents add constraint order_intents_action_check
  check (action = any (array['open'::text, 'close'::text, 'amend_tpsl'::text, 'reduce'::text, 'set_leverage'::text]));
