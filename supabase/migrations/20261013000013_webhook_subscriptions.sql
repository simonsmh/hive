-- Webhook push to agents. Subscriptions carry a filter; a prefilter runs inside the insert trigger on
-- news_items and alerts, so only matching subscribers get a webhook_deliveries row and agents are never
-- woken for non-matching events. The webhook-dispatcher Edge Function claims due rows, signs and POSTs them,
-- and records the outcome. The signing secret lives in Vault; this table only references it.

alter table public.alerts add column if not exists severity text not null default 'info'
  check (severity in ('info', 'warning', 'critical'));
alter table public.alerts add column if not exists resolved_at timestamptz;
create index if not exists alerts_open_idx on public.alerts (kind, triggered_at desc) where resolved_at is null;

create table if not exists public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  agent_name text not null unique check (agent_name ~ '^[a-z0-9_-]{1,64}$'),
  url text not null check (url ~ '^https://' and length(url) <= 2048),
  secret_id uuid references vault.secrets (id) on delete set null,
  event_types text[] not null default array['news', 'alert']::text[]
    check (cardinality(event_types) > 0 and event_types <@ array['news', 'alert']::text[]),
  -- Keys: sources, keywords, severities, alert_kinds, symbols. A missing or empty list places no constraint.
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.webhook_deliveries (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.webhook_subscriptions (id) on delete cascade,
  event_type text not null check (event_type in ('news', 'alert')),
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
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at)
  where status in ('pending', 'sending');
create index if not exists webhook_deliveries_created_idx on public.webhook_deliveries (created_at desc);

-- An empty or absent list places no constraint. A non-empty list requires a matching value.
create or replace function public.hive_filter_allows(p_list jsonb, p_value text)
returns boolean
language sql
immutable
as $$
  select case
    when p_list is null or jsonb_typeof(p_list) <> 'array' or jsonb_array_length(p_list) = 0 then true
    when p_value is null then false
    else exists (select 1 from jsonb_array_elements_text(p_list) e where lower(e) = lower(p_value))
  end
$$;

-- Keywords match as case-insensitive substrings of the event text. position() avoids LIKE escaping.
create or replace function public.hive_keywords_allow(p_list jsonb, p_text text)
returns boolean
language sql
immutable
as $$
  select case
    when p_list is null or jsonb_typeof(p_list) <> 'array' or jsonb_array_length(p_list) = 0 then true
    else exists (
      select 1 from jsonb_array_elements_text(p_list) k
       where position(lower(k) in lower(coalesce(p_text, ''))) > 0
    )
  end
$$;

create or replace function public.hive_subscription_matches(
  p_filters jsonb,
  p_source text,
  p_severity text,
  p_alert_kind text,
  p_symbol text,
  p_text text
)
returns boolean
language sql
immutable
as $$
  select public.hive_filter_allows(p_filters->'sources', p_source)
     and public.hive_keywords_allow(p_filters->'keywords', p_text)
     and public.hive_filter_allows(p_filters->'severities', p_severity)
     and public.hive_filter_allows(p_filters->'alert_kinds', p_alert_kind)
     and public.hive_filter_allows(p_filters->'symbols', p_symbol)
$$;

create or replace function public.hive_fanout_news()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.webhook_deliveries (subscription_id, event_type, event_key, payload)
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
         )
    from public.webhook_subscriptions s
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
  return new;
end
$$;

drop trigger if exists news_items_fanout on public.news_items;
create trigger news_items_fanout after insert on public.news_items
  for each row execute function public.hive_fanout_news();

drop trigger if exists alerts_fanout on public.alerts;
create trigger alerts_fanout after insert on public.alerts
  for each row execute function public.hive_fanout_alert();

-- Creates or updates a subscription. Absent (null) arguments keep their current value on update. A new
-- secret is written to Vault under a unique name and the previous one is removed. Raises P0002 when the id is unknown.
create or replace function public.hive_upsert_webhook_subscription(
  p_id uuid,
  p_agent_name text,
  p_url text,
  p_secret text,
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
    select secret_id into v_old_secret from public.webhook_subscriptions where id = p_id;
    if not found then
      raise exception 'webhook subscription % not found', p_id using errcode = 'P0002';
    end if;
  end if;

  if p_secret is not null then
    v_new_secret := vault.create_secret(p_secret, 'webhook_sub:' || v_id::text || ':' || gen_random_uuid()::text,
                                        'Hive webhook signing secret');
  end if;

  if p_id is null then
    insert into public.webhook_subscriptions (id, agent_name, url, secret_id, event_types, filters, enabled)
    values (v_id, p_agent_name, p_url, v_new_secret,
            coalesce(p_event_types, array['news', 'alert']::text[]),
            coalesce(p_filters, '{}'::jsonb),
            coalesce(p_enabled, true));
  else
    update public.webhook_subscriptions
       set agent_name = coalesce(p_agent_name, agent_name),
           url = coalesce(p_url, url),
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

create or replace function public.hive_delete_webhook_subscription(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
#variable_conflict use_column
declare
  v_secret uuid;
begin
  delete from public.webhook_subscriptions where id = p_id returning secret_id into v_secret;
  if not found then return false; end if;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
  return true;
end
$$;

-- Claims due deliveries for one dispatcher run. Rows left in 'sending' past their lease are reclaimed,
-- so a crashed run does not strand a delivery. attempts is incremented at claim time.
create or replace function public.hive_webhook_claim(p_limit integer, p_lease_seconds integer)
returns table (
  delivery_id bigint,
  agent_name text,
  url text,
  secret text,
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
      from public.webhook_deliveries d
      join public.webhook_subscriptions s on s.id = d.subscription_id
     where s.enabled
       and ((d.status = 'pending' and d.next_attempt_at <= now())
            or (d.status = 'sending' and d.locked_until < now()))
     order by d.next_attempt_at
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
    returning d.id, d.subscription_id, d.event_type, d.payload, d.attempts, d.max_attempts
  )
  select c.id, s.agent_name, s.url, ds.decrypted_secret, c.event_type, c.payload, c.attempts, c.max_attempts
    from claimed c
    join public.webhook_subscriptions s on s.id = c.subscription_id
    left join vault.decrypted_secrets ds on ds.id = s.secret_id;
end
$$;

-- Records one attempt. A success is final. A failure is retried after p_backoff_seconds until max_attempts,
-- then the delivery is marked dead. Returns the resulting status.
create or replace function public.hive_webhook_mark(
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
    update public.webhook_deliveries
       set status = 'delivered', delivered_at = now(), response_status = p_response_status,
           last_error = null, locked_until = null, updated_at = now()
     where id = p_delivery_id
    returning status into v_status;
    return v_status;
  end if;

  update public.webhook_deliveries d
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

alter table public.webhook_subscriptions enable row level security;
alter table public.webhook_deliveries enable row level security;
create policy service_role_all on public.webhook_subscriptions for all to service_role using (true) with check (true);
create policy service_role_all on public.webhook_deliveries for all to service_role using (true) with check (true);
revoke all on public.webhook_subscriptions, public.webhook_deliveries from anon, authenticated;
grant select, insert, update, delete on public.webhook_subscriptions, public.webhook_deliveries to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function public.hive_filter_allows(jsonb, text) from public, anon, authenticated;
revoke execute on function public.hive_keywords_allow(jsonb, text) from public, anon, authenticated;
revoke execute on function public.hive_subscription_matches(jsonb, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.hive_fanout_news() from public, anon, authenticated;
revoke execute on function public.hive_fanout_alert() from public, anon, authenticated;
revoke execute on function public.hive_upsert_webhook_subscription(uuid, text, text, text, text[], jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.hive_delete_webhook_subscription(uuid) from public, anon, authenticated;
revoke execute on function public.hive_webhook_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.hive_webhook_mark(bigint, boolean, integer, text, integer) from public, anon, authenticated;

grant execute on function public.hive_upsert_webhook_subscription(uuid, text, text, text, text[], jsonb, boolean) to service_role;
grant execute on function public.hive_delete_webhook_subscription(uuid) to service_role;
grant execute on function public.hive_webhook_claim(integer, integer) to service_role;
grant execute on function public.hive_webhook_mark(bigint, boolean, integer, text, integer) to service_role;
