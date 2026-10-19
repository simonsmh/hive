-- Widen orders.state to the full OKX state vocabulary. order-sync writes exchange states back
-- verbatim; algo orders add effective / partially_effective / order_failed, and regular orders can
-- end as mmp_canceled. The original list (migration 24) only covered the states known at placement
-- time, so the sync PATCH for those rows would violate the CHECK and retry forever.
alter table public.orders drop constraint orders_state_check;

alter table public.orders add constraint orders_state_check check (
  state in (
    'accepted', 'live', 'partially_filled', 'partially_effective',
    'filled', 'canceled', 'mmp_canceled', 'effective', 'order_failed', 'failed'
  )
);
