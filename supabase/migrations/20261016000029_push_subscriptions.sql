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

-- 3) Claim ledger with a 30-minute lease. A plain insert would make the claim permanent:
--    if the function died after claiming but before sending, every later run would
--    silently skip that (subscription, event) pair forever. On conflict the claim is
--    adopted only when the previous owner clearly died with it (lease expired); a
--    live claim is reported as already taken.
create or replace function public.hive_push_claim(p_subscription_id uuid, p_event_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fast path: brand-new claim.
  insert into public.push_deliveries (subscription_id, event_key)
  values (p_subscription_id, p_event_key)
  on conflict do nothing;
  if found then
    return true;
  end if;
  -- Conflicting claim: take it over only when the lease expired.
  update public.push_deliveries
     set created_at = now()
   where subscription_id = p_subscription_id
     and event_key = p_event_key
     and created_at < now() - interval '30 minutes';
  return found;
end;
$$;

revoke execute on function public.hive_push_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.hive_push_claim(uuid, text) to service_role;

-- 4) Daily prune of the delivery ledger (free-tier retention): rows older than 7 days
--    are long past the event lookback and claim lease, so they no longer dedupe anything.
create or replace function public.hive_prune_push_deliveries()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_deliveries where created_at < now() - interval '7 days';
$$;

revoke execute on function public.hive_prune_push_deliveries() from public, anon, authenticated;
grant execute on function public.hive_prune_push_deliveries() to service_role;

-- 5) Fan-out every minute through the generic invoker (Vault-held URL and secret),
--    and prune the ledger daily alongside the other prune jobs.
select cron.schedule('hive-push-notify', '* * * * *', $$select public.hive_invoke_edge_function('push-notify')$$);
select cron.schedule('hive-push-prune', '35 3 * * *', $$select public.hive_prune_push_deliveries()$$);
