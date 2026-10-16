-- Webhook delivery hygiene (P0a). Builds on the fan-out, claim and mark functions in 20261013000013, the Edge invoker
-- in 20261013000015 and the news kick in 20261013000017.
--
-- Priority is decided per delivery from its event type and alert kind, so existing subscriptions and filters keep
-- their meaning and no subscription row has to change:
--   critical  news, and the alert kinds that drive trading decisions: fill, near_sl, position, order_state,
--             premium_pulse, candle_close_break (breakout), price_cross. Claimed first, never dropped.
--   bulk      every other alert kind, including noisy patrols such as 5m scans. A bulk row still unsent after
--             expires_at is marked 'expired' and never sent, so a backlog cannot replay it.
-- Every delivery carries event_ts (when known), stale_after_seconds and expires_at. The dispatcher sets stale and
-- replay in the payload at send time (packages/core/src/webhook.ts), so a delayed delivery is never presented as fresh.
-- A critical alert kicks the dispatcher once per transaction, so it does not wait for the 30-second cron.

alter table public.webhook_deliveries
  add column if not exists priority text not null default 'critical' check (priority in ('critical', 'bulk')),
  add column if not exists event_ts timestamptz,
  add column if not exists stale_after_seconds integer not null default 300 check (stale_after_seconds > 0),
  add column if not exists expires_at timestamptz;

alter table public.webhook_deliveries drop constraint if exists webhook_deliveries_status_check;
alter table public.webhook_deliveries add constraint webhook_deliveries_status_check
  check (status in ('pending', 'sending', 'delivered', 'dead', 'expired'));

-- Single source of truth for priority, staleness and expiry. Stale thresholds: fill 60 s, other critical alerts 120 s,
-- news and bulk 300 s. Bulk rows expire 900 s after insert. Critical rows never expire.
create or replace function public.hive_delivery_policy(p_event_type text, p_kind text)
returns table (priority text, stale_after_seconds integer, expires_after_seconds integer)
language sql
immutable
as $$
  select
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross')
         then 'critical' else 'bulk' end,
    case when p_kind = 'fill' then 60
         when p_event_type = 'alert'
           and p_kind in ('near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross') then 120
         else 300 end,
    case when p_event_type = 'news'
           or p_kind in ('fill', 'near_sl', 'position', 'order_state', 'premium_pulse', 'candle_close_break', 'price_cross')
         then null else 900 end
$$;

revoke all on function public.hive_delivery_policy(text, text) from public, anon, authenticated;

with classified as (
  select d.id,
         p.priority,
         p.stale_after_seconds,
         p.expires_after_seconds,
         coalesce(nullif(d.payload->>'event_ts', '')::timestamptz,
                  nullif(d.payload->>'published_at', '')::timestamptz,
                  nullif(d.payload->>'triggered_at', '')::timestamptz,
                  d.created_at) as event_ts,
         d.created_at
    from public.webhook_deliveries d
    cross join lateral public.hive_delivery_policy(d.event_type, d.payload->>'kind') p
)
update public.webhook_deliveries d
   set priority = c.priority,
       stale_after_seconds = c.stale_after_seconds,
       event_ts = c.event_ts,
       expires_at = case when c.expires_after_seconds is null then null
                         else c.created_at + make_interval(secs => c.expires_after_seconds) end
  from classified c
 where c.id = d.id;

create index if not exists webhook_deliveries_expiry_idx on public.webhook_deliveries (expires_at)
  where expires_at is not null and status in ('pending', 'sending');

create or replace function public.hive_fanout_news()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.webhook_deliveries (subscription_id, event_type, event_key, payload, priority, event_ts, stale_after_seconds, expires_at)
  select s.id, 'news', 'news:' || new.id,
         jsonb_build_object(
           'type', 'news',
           'id', new.id,
           'source', new.source,
           'title', new.title,
           'body', new.body,
           'url', new.url,
           'author', new.author,
           'published_at', new.published_at,
           'important', coalesce(new.score, 0) >= 1,
           'event_id', new.event_id
         ),
         p.priority,
         coalesce(new.published_at, new.fetched_at),
         p.stale_after_seconds,
         case when p.expires_after_seconds is null then null
              else now() + make_interval(secs => p.expires_after_seconds) end
    from public.webhook_subscriptions s
    cross join public.hive_delivery_policy('news', null) p
   where s.enabled
     and 'news' = any (s.event_types)
     and public.hive_subscription_matches(
           s.filters,
           new.source,
           case when coalesce(new.score, 0) >= 1 then 'warning' else 'info' end,
           null,
           null,
           coalesce(new.title, '') || ' ' || coalesce(new.body, '')
         )
  on conflict (subscription_id, event_key) do nothing;
  return new;
end
$$;

create or replace function public.hive_fanout_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_critical boolean;
begin
  with inserted as (
    insert into public.webhook_deliveries (subscription_id, event_type, event_key, payload, priority, event_ts, stale_after_seconds, expires_at)
    select s.id, 'alert', 'alert:' || new.id,
           jsonb_build_object(
             'type', 'alert',
             'id', new.id,
             'kind', new.kind,
             'severity', new.severity,
             'symbol', new.symbol,
             'source', new.payload->>'source',
             'triggered_at', new.triggered_at,
             'payload', new.payload
           ),
           p.priority,
           coalesce(nullif(new.payload->>'event_ts', '')::timestamptz, new.triggered_at),
           p.stale_after_seconds,
           case when p.expires_after_seconds is null then null
                else now() + make_interval(secs => p.expires_after_seconds) end
      from public.webhook_subscriptions s
      cross join public.hive_delivery_policy('alert', new.kind) p
     where s.enabled
       and 'alert' = any (s.event_types)
       and public.hive_subscription_matches(
             s.filters - 'sources',
             null,
             new.severity,
             new.kind,
             new.symbol,
             new.kind || ' ' || new.payload::text
           )
    on conflict (subscription_id, event_key) do nothing
    returning priority
  )
  select exists (select 1 from inserted where priority = 'critical') into v_critical;

  -- One kick per transaction is enough: a run claims every due row. The flag is transaction-local.
  if v_critical and current_setting('hive.webhook_kick_queued', true) is distinct from 'on' then
    perform public.hive_invoke_edge_function('webhook-dispatcher');
    perform set_config('hive.webhook_kick_queued', 'on', true);
  end if;
  return new;
end
$$;

-- Claim order: critical rows first, then the oldest due row. A bulk row past expires_at is expired here, so it is
-- never leased. A critical row past its stale threshold is still claimed. The dispatcher marks it stale.
-- The return type changes, so the function is dropped and recreated. It keeps the auth_token column from 20261013000016.
drop function if exists public.hive_webhook_claim(integer, integer);

create or replace function public.hive_webhook_claim(p_limit integer, p_lease_seconds integer)
returns table (
  delivery_id bigint,
  agent_name text,
  url text,
  secret text,
  auth_token text,
  event_type text,
  payload jsonb,
  attempts integer,
  max_attempts integer,
  priority text,
  event_ts timestamptz,
  created_at timestamptz,
  stale_after_seconds integer
)
language plpgsql
security definer
set search_path = public, vault
as $$
#variable_conflict use_column
begin
  update public.webhook_deliveries d
     set status = 'expired',
         last_error = 'expired before delivery',
         locked_until = null,
         updated_at = now()
   where d.priority = 'bulk'
     and d.expires_at < now()
     and (d.status = 'pending' or (d.status = 'sending' and d.locked_until < now()));

  return query
  with due as (
    select d.id
      from public.webhook_deliveries d
      join public.webhook_subscriptions s on s.id = d.subscription_id
     where s.enabled
       and ((d.status = 'pending' and d.next_attempt_at <= now())
            or (d.status = 'sending' and d.locked_until < now()))
     order by (d.priority = 'critical') desc, d.next_attempt_at
     limit greatest(p_limit, 1)
       for update of d skip locked
  ),
  claimed as (
    update public.webhook_deliveries d
       set status = 'sending',
           attempts = d.attempts + 1,
           locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
           updated_at = now()
      from due
     where d.id = due.id
    returning d.id, d.subscription_id, d.event_type, d.payload, d.attempts, d.max_attempts,
              d.priority, d.event_ts, d.created_at, d.stale_after_seconds
  )
  select c.id, s.agent_name, s.url, ds.decrypted_secret, da.decrypted_secret, c.event_type, c.payload,
         c.attempts, c.max_attempts, c.priority, c.event_ts, c.created_at, c.stale_after_seconds
    from claimed c
    join public.webhook_subscriptions s on s.id = c.subscription_id
    left join vault.decrypted_secrets ds on ds.id = s.secret_id
    left join vault.decrypted_secrets da on da.id = s.auth_token_secret_id
   order by (c.priority = 'critical') desc, c.id;
end
$$;

-- Returns claimed rows that the dispatcher could not send before its budget ran out. The attempt that the claim
-- counted is refunded, so a deferred bulk row does not drift toward dead.
create or replace function public.hive_webhook_release(p_delivery_ids bigint[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_released integer;
begin
  update public.webhook_deliveries d
     set status = 'pending',
         attempts = greatest(d.attempts - 1, 0),
         locked_until = null,
         updated_at = now()
   where d.id = any(p_delivery_ids)
     and d.status = 'sending';
  get diagnostics v_released = row_count;
  return v_released;
end
$$;

create or replace function public.hive_prune_news_and_webhooks(
  p_delivery_days integer default 14,
  p_news_days integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deliveries integer := 0;
  v_events integer := 0;
  v_news integer := 0;
begin
  delete from public.webhook_deliveries
   where status in ('delivered', 'dead', 'expired')
     and updated_at < now() - make_interval(days => p_delivery_days);
  get diagnostics v_deliveries = row_count;

  delete from public.news_events where first_published_at < now() - make_interval(days => p_news_days);
  get diagnostics v_events = row_count;

  delete from public.news_items
   where fetched_at < now() - make_interval(days => p_news_days)
     and id not in (select earliest_item_id from public.news_events where earliest_item_id is not null);
  get diagnostics v_news = row_count;

  return jsonb_build_object('webhook_deliveries', v_deliveries, 'news_events', v_events, 'news_items', v_news);
end
$$;

revoke execute on function public.hive_fanout_news() from public, anon, authenticated;
revoke execute on function public.hive_fanout_alert() from public, anon, authenticated;
revoke execute on function public.hive_webhook_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.hive_webhook_release(bigint[]) from public, anon, authenticated;
revoke execute on function public.hive_prune_news_and_webhooks(integer, integer) from public, anon, authenticated;
grant execute on function public.hive_webhook_claim(integer, integer) to service_role;
grant execute on function public.hive_webhook_release(bigint[]) to service_role;
grant execute on function public.hive_prune_news_and_webhooks(integer, integer) to service_role;
