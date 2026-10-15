-- PWA Web Push: browser subscriptions for news and alert notifications, plus the delivery ledger
-- that keeps the per-minute push-notify run from sending the same event twice.
-- Additive: two new tables and one cron job. Nothing existing changes.

-- 1) One row per browser push endpoint. filters gates which event classes the owner wants:
--    {"news": true, "alerts": true}. Keys are the subscription's own public material
--    (p256dh is a public key, auth is the RFC 8291 shared secret the browser issued for us);
--    rows are service-role only, like every other table.
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  filters jsonb not null default '{"news": true, "alerts": true}'::jsonb,
  user_agent text,
  failure_count integer not null default 0,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;

-- 2) Delivery ledger. event_key is `news:<event id>` or `alert:<alert id>`; the unique pair is
--    claimed before sending so overlapping runs cannot double-send.
create table public.push_deliveries (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.push_subscriptions (id) on delete cascade,
  event_key text not null,
  created_at timestamptz not null default now(),
  unique (subscription_id, event_key)
);

create index push_deliveries_created_idx on public.push_deliveries (created_at desc);

alter table public.push_deliveries enable row level security;

revoke all on public.push_deliveries from anon, authenticated;
grant select, insert, delete on public.push_deliveries to service_role;

-- 3) Fan-out every minute through the generic invoker (Vault-held URL and secret).
select cron.schedule('hive-push-notify', '* * * * *', $$select public.hive_invoke_edge_function('push-notify')$$);
