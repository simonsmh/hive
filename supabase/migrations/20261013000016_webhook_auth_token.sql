-- Optional per-subscription bearer token, sent as "Authorization: Bearer <token>" alongside the HMAC headers
-- (for receivers such as Grok Bot routine webhooks). The token is stored in Vault like the signing secret; the
-- subscription row only references it. Also: the sources filter applies to news only, so alerts are not
-- blocked by a news source list. Additive: new column, new defaulted parameters, body-only changes elsewhere.

alter table public.webhook_subscriptions
  add column if not exists auth_token_secret_id uuid references vault.secrets (id) on delete set null;

-- The 7-argument overload is replaced by a 9-argument one. The new parameters default, so existing
-- positional and named calls with seven arguments keep working; the old overload is dropped to avoid ambiguity.
drop function if exists public.hive_upsert_webhook_subscription(uuid, text, text, text, text[], jsonb, boolean);

create or replace function public.hive_upsert_webhook_subscription(
  p_id uuid,
  p_agent_name text,
  p_url text,
  p_secret text,
  p_event_types text[],
  p_filters jsonb,
  p_enabled boolean,
  p_auth_token text default null,
  p_clear_auth_token boolean default false
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
  v_old_auth uuid;
  v_new_auth uuid;
  v_clear boolean := coalesce(p_clear_auth_token, false);
begin
  if p_auth_token is not null and v_clear then
    raise exception 'p_auth_token and p_clear_auth_token are mutually exclusive' using errcode = '22023';
  end if;

  if p_id is not null then
    select secret_id, auth_token_secret_id into v_old_secret, v_old_auth
      from public.webhook_subscriptions where id = p_id;
    if not found then
      raise exception 'webhook subscription % not found', p_id using errcode = 'P0002';
    end if;
  end if;

  if p_secret is not null then
    v_new_secret := vault.create_secret(p_secret, 'webhook_sub:' || v_id::text || ':' || gen_random_uuid()::text,
                                        'Hive webhook signing secret');
  end if;

  if p_auth_token is not null then
    v_new_auth := vault.create_secret(p_auth_token, 'webhook_auth:' || v_id::text || ':' || gen_random_uuid()::text,
                                      'Hive webhook bearer token');
  end if;

  if p_id is null then
    insert into public.webhook_subscriptions (id, agent_name, url, secret_id, event_types, filters, enabled, auth_token_secret_id)
    values (v_id, p_agent_name, p_url, v_new_secret,
            coalesce(p_event_types, array['news', 'alert']::text[]),
            coalesce(p_filters, '{}'::jsonb),
            coalesce(p_enabled, true),
            v_new_auth);
  else
    update public.webhook_subscriptions
       set agent_name = coalesce(p_agent_name, agent_name),
           url = coalesce(p_url, url),
           secret_id = coalesce(v_new_secret, v_old_secret),
           auth_token_secret_id = case when v_clear then null else coalesce(v_new_auth, v_old_auth) end,
           event_types = coalesce(p_event_types, event_types),
           filters = coalesce(p_filters, filters),
           enabled = coalesce(p_enabled, enabled),
           updated_at = now()
     where id = v_id;
    if v_new_secret is not null and v_old_secret is not null then
      delete from vault.secrets where id = v_old_secret;
    end if;
    if v_new_auth is not null and v_old_auth is not null then
      delete from vault.secrets where id = v_old_auth;
    end if;
    if v_clear and v_old_auth is not null then
      delete from vault.secrets where id = v_old_auth;
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
  v_auth uuid;
begin
  delete from public.webhook_subscriptions where id = p_id
  returning secret_id, auth_token_secret_id into v_secret, v_auth;
  if not found then return false; end if;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
  if v_auth is not null then
    delete from vault.secrets where id = v_auth;
  end if;
  return true;
end
$$;

-- Adds auth_token to the claim result. The return type changes, so the function is dropped and recreated.
-- Older dispatchers read fields by name and ignore the extra column.
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
  select c.id, s.agent_name, s.url, ds.decrypted_secret, da.decrypted_secret, c.event_type, c.payload,
         c.attempts, c.max_attempts
    from claimed c
    join public.webhook_subscriptions s on s.id = c.subscription_id
    left join vault.decrypted_secrets ds on ds.id = s.secret_id
    left join vault.decrypted_secrets da on da.id = s.auth_token_secret_id;
end
$$;

-- Alerts are not filtered by sources: the list names news outlets, and alerts carry no news source.
-- Sources still apply to news in hive_fanout_news.
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
           s.filters - 'sources',
           null,
           new.severity,
           new.kind,
           new.symbol,
           new.kind || ' ' || new.payload::text
         )
  on conflict (subscription_id, event_key) do nothing;
  return new;
end
$$;

revoke execute on function public.hive_upsert_webhook_subscription(uuid, text, text, text, text[], jsonb, boolean, text, boolean) from public, anon, authenticated;
revoke execute on function public.hive_webhook_claim(integer, integer) from public, anon, authenticated;
grant execute on function public.hive_upsert_webhook_subscription(uuid, text, text, text, text[], jsonb, boolean, text, boolean) to service_role;
grant execute on function public.hive_webhook_claim(integer, integer) to service_role;
