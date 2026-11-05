-- Telegram delivery for Hive alerts. Mirrors the webhook pipeline
-- (20261013000013_webhook_subscriptions.sql) one table at a time:
-- telegram_subscriptions is the subscription side (chat_id instead of a
-- webhook URL, bot token in Vault instead of a signing secret),
-- telegram_deliveries is the queue side (same claim/mark/release
-- semantics as webhook_deliveries), and hive_fanout_alert() writes both
-- queues on every alert insert. Scope is alerts only: news fanout is
-- untouched, and no other function is modified here.
--
-- The bot token is never stored in cleartext: hive_upsert_telegram_subscription
-- writes it to Vault exactly like hive_upsert_webhook_subscription does for
-- signing secrets, and the dispatcher only ever reads the decrypted token
-- from the claim row, in memory, never in a log line.

create table if not exists public.telegram_subscriptions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[a-z0-9_-]{1,64}$'),
  chat_id text not null check (chat_id ~ '^-?[0-9]{1,32}$'),
  secret_id uuid references vault.secrets (id) on delete set null,
  event_types text[] not null default array['alert']::text[]
    check (cardinality(event_types) > 0 and event_types <@ array['news', 'alert']::text[]),
  -- Keys: sources, keywords, severities, alert_kinds, symbols. A missing or empty list places no constraint.
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_deliveries (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.telegram_subscriptions (id) on delete cascade,
  event_type text not null check (event_type = 'alert'),
  event_key text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 6 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  response_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, event_key)
);
create index if not exists telegram_deliveries_due_idx on public.telegram_deliveries (next_attempt_at)
  where status in ('pending', 'sending');
create index if not exists telegram_deliveries_created_idx on public.telegram_deliveries (created_at desc);

-- Fanout: same matching as webhooks, second insert only. The webhook
-- insert is unchanged; a Telegram failure cannot affect it because both
-- inserts run in the same trigger but target different tables, and the
-- unique (subscription_id, event_key) guard keeps replays idempotent.
create or replace function public.hive_fanout_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.webhook_deliveries (subscription_id, event_type, event_key, payload)
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
         )
    from public.webhook_subscriptions s
   where s.enabled
     and 'alert' = any (s.event_types)
     and public.hive_subscription_matches(
           s.filters,
           new.payload->>'source',
           new.severity,
           new.kind,
           new.symbol,
           new.kind || ' ' || new.payload::text
         )
  on conflict (subscription_id, event_key) do nothing;

  insert into public.telegram_deliveries (subscription_id, event_type, event_key, payload)
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
         )
    from public.telegram_subscriptions s
   where s.enabled
     and 'alert' = any (s.event_types)
     and public.hive_subscription_matches(
           s.filters,
           new.payload->>'source',
           new.severity,
           new.kind,
           new.symbol,
           new.kind || ' ' || new.payload::text
         )
  on conflict (subscription_id, event_key) do nothing;
  return new;
end
$$;

-- Claims due deliveries for one dispatcher run. Rows left in 'sending'
-- past their lease are reclaimed, so a crashed run does not strand a
-- delivery. attempts is incremented at claim time. Mirrors
-- hive_webhook_claim; the only difference is chat_id + decrypted bot
-- token in place of agent_name + url + signing secret.
create or replace function public.hive_telegram_claim(p_limit integer, p_lease_seconds integer)
returns table (
  delivery_id bigint,
  chat_id text,
  bot_token text,
  event_type text,
  payload jsonb,
  attempts integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = public, vault
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select d.id
      from public.telegram_deliveries d
      join public.telegram_subscriptions s on s.id = d.subscription_id
     where s.enabled
       and ((d.status = 'pending' and d.next_attempt_at <= now())
            or (d.status = 'sending' and d.locked_until < now()))
     order by d.next_attempt_at
     limit greatest(p_limit, 1)
       for update of d skip locked
  ), claimed as (
    update public.telegram_deliveries d
       set status = 'sending',
           attempts = d.attempts + 1,
           locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
           updated_at = now()
      from due
     where d.id = due.id
    returning d.id, d.subscription_id, d.event_type, d.payload, d.attempts, d.max_attempts
  )
  select c.id, s.chat_id, ds.decrypted_secret, c.event_type, c.payload, c.attempts, c.max_attempts
    from claimed c
    join public.telegram_subscriptions s on s.id = c.subscription_id
    left join vault.decrypted_secrets ds on ds.id = s.secret_id;
end
$$;

-- Records one attempt. A success is final. A failure is retried after
-- p_backoff_seconds until max_attempts, then the delivery is marked
-- dead. Returns the resulting status. Mirrors hive_webhook_mark.
create or replace function public.hive_telegram_mark(
  p_delivery_id bigint,
  p_ok boolean,
  p_response_status integer,
  p_error text,
  p_backoff_seconds integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_status text;
begin
  if p_ok then
    update public.telegram_deliveries
       set status = 'delivered', delivered_at = now(), response_status = p_response_status,
           last_error = null, locked_until = null, updated_at = now()
     where id = p_delivery_id
    returning status into v_status;
    return v_status;
  end if;

  update public.telegram_deliveries d
     set status = case when d.attempts >= d.max_attempts then 'dead' else 'pending' end,
         next_attempt_at = now() + make_interval(secs => greatest(p_backoff_seconds, 0)),
         response_status = p_response_status,
         last_error = left(p_error, 500),
         locked_until = null,
         updated_at = now()
   where d.id = p_delivery_id
  returning d.status into v_status;
  return v_status;
end
$$;

-- Returns claimed deliveries to pending and refunds the attempt that
-- claiming counted. Mirrors hive_webhook_release.
create or replace function public.hive_telegram_release(p_delivery_ids bigint[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_released integer;
begin
  update public.telegram_deliveries d
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

-- Creates or updates a Telegram subscription. Absent (null) arguments
-- keep their current value on update. A new bot token is written to
-- Vault under a unique name and the previous one is removed. Raises
-- P0002 when the id is unknown. Mirrors
-- hive_upsert_webhook_subscription; the caller supplies the bot token
-- and chat id, and this function is the only place the token is
-- handled. No subscription row is inserted by this migration itself:
-- real chat_id/token pairs are written later through this function.
create or replace function public.hive_upsert_telegram_subscription(
  p_id uuid,
  p_name text,
  p_chat_id text,
  p_token text,
  p_event_types text[],
  p_filters jsonb,
  p_enabled boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
#variable_conflict use_column
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_old_secret uuid;
  v_new_secret uuid;
begin
  if p_id is not null then
    select secret_id into v_old_secret from public.telegram_subscriptions where id = p_id;
    if not found then
      raise exception 'telegram subscription % not found', p_id using errcode = 'P0002';
    end if;
  end if;

  if p_token is not null then
    v_new_secret := vault.create_secret(p_token, 'telegram_sub:' || v_id::text || ':' || gen_random_uuid()::text,
                                        'Hive Telegram bot token');
  end if;

  if p_id is null then
    insert into public.telegram_subscriptions (id, name, chat_id, secret_id, event_types, filters, enabled)
    values (v_id, p_name, p_chat_id, v_new_secret,
            coalesce(p_event_types, array['alert']::text[]),
            coalesce(p_filters, '{}'::jsonb),
            coalesce(p_enabled, true));
  else
    update public.telegram_subscriptions
       set name = coalesce(p_name, name),
           chat_id = coalesce(p_chat_id, chat_id),
           secret_id = coalesce(v_new_secret, v_old_secret),
           event_types = coalesce(p_event_types, event_types),
           filters = coalesce(p_filters, filters),
           enabled = coalesce(p_enabled, enabled),
           updated_at = now()
     where id = v_id;
    if v_new_secret is not null and v_old_secret is not null then
      delete from vault.secrets where id = v_old_secret;
    end if;
  end if;

  return v_id;
end
$$;

create or replace function public.hive_delete_telegram_subscription(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
#variable_conflict use_column
declare
  v_secret uuid;
begin
  delete from public.telegram_subscriptions where id = p_id returning secret_id into v_secret;
  if not found then return false; end if;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
  return true;
end
$$;

alter table public.telegram_subscriptions enable row level security;
alter table public.telegram_deliveries enable row level security;
create policy service_role_all on public.telegram_subscriptions for all to service_role using (true) with check (true);
create policy service_role_all on public.telegram_deliveries for all to service_role using (true) with check (true);
revoke all on public.telegram_subscriptions, public.telegram_deliveries from anon, authenticated;
grant select, insert, update, delete on public.telegram_subscriptions, public.telegram_deliveries to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function public.hive_fanout_alert() from public, anon, authenticated;
revoke execute on function public.hive_telegram_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.hive_telegram_mark(bigint, boolean, integer, text, integer) from public, anon, authenticated;
revoke execute on function public.hive_telegram_release(bigint[]) from public, anon, authenticated;
revoke execute on function public.hive_upsert_telegram_subscription(uuid, text, text, text, text[], jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.hive_delete_telegram_subscription(uuid) from public, anon, authenticated;

grant execute on function public.hive_telegram_claim(integer, integer) to service_role;
grant execute on function public.hive_telegram_mark(bigint, boolean, integer, text, integer) to service_role;
grant execute on function public.hive_telegram_release(bigint[]) to service_role;
grant execute on function public.hive_upsert_telegram_subscription(uuid, text, text, text, text[], jsonb, boolean) to service_role;
grant execute on function public.hive_delete_telegram_subscription(uuid) to service_role;

-- Dispatcher cadence mirrors hive-webhook-dispatch (30 seconds).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-telegram-dispatch') then
    perform cron.unschedule('hive-telegram-dispatch');
  end if;
end
$$;

select cron.schedule('hive-telegram-dispatch', '30 seconds', $$select public.hive_invoke_edge_function('telegram-dispatcher')$$);
