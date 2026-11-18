-- A-share index 5m volume_spike rules, plus a secret-safe webhook destination clone RPC.
-- Additive and idempotent. Does not touch trading switches, existing subscriptions, or cron
-- (sina-intraday and alert-evaluator jobs already exist in production).
-- hive_clone_webhook_destination copies url + Vault secrets inside a security definer function
-- and never returns credentials, so a new agent can reuse a working destination without
-- reading or rotating the source row.

-- 1) Clone a subscription's destination (url, HMAC secret, optional bearer) into a new agent.
--    Secrets are duplicated in Vault, not shared, so later delete/rotate of one row cannot
--    break the other. Returns only the new id. Filters and event_types are taken from the
--    caller, not from the source.
create or replace function public.hive_clone_webhook_destination(
  p_from_agent text,
  p_new_agent text,
  p_event_types text[],
  p_filters jsonb default '{}'::jsonb,
  p_enabled boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
#variable_conflict use_column
declare
  v_url text;
  v_secret uuid;
  v_auth uuid;
  v_secret_value text;
  v_auth_value text;
  v_new_secret uuid;
  v_new_auth uuid;
  v_id uuid := gen_random_uuid();
begin
  if p_from_agent is null or p_from_agent !~ '^[a-z0-9_-]{1,64}$' then
    raise exception 'p_from_agent must match [a-z0-9_-]{1,64}' using errcode = '22023';
  end if;
  if p_new_agent is null or p_new_agent !~ '^[a-z0-9_-]{1,64}$' then
    raise exception 'p_new_agent must match [a-z0-9_-]{1,64}' using errcode = '22023';
  end if;
  if p_from_agent = p_new_agent then
    raise exception 'p_new_agent must be different from p_from_agent' using errcode = '22023';
  end if;
  if p_event_types is null
     or cardinality(p_event_types) = 0
     or not (p_event_types <@ array['news', 'alert']::text[]) then
    raise exception 'p_event_types must be a non-empty subset of news, alert' using errcode = '22023';
  end if;
  if p_filters is null or jsonb_typeof(p_filters) <> 'object' then
    raise exception 'p_filters must be a JSON object' using errcode = '22023';
  end if;

  select s.url, s.secret_id, s.auth_token_secret_id
    into v_url, v_secret, v_auth
    from public.webhook_subscriptions s
   where s.agent_name = p_from_agent;
  if not found then
    raise exception 'source webhook subscription % not found', p_from_agent using errcode = 'P0002';
  end if;
  if exists (select 1 from public.webhook_subscriptions s where s.agent_name = p_new_agent) then
    raise exception 'webhook subscription % already exists', p_new_agent using errcode = '23505';
  end if;
  if v_url is null or v_secret is null then
    raise exception 'source webhook subscription % is missing a url or signing secret', p_from_agent using errcode = '22023';
  end if;

  select ds.decrypted_secret into v_secret_value from vault.decrypted_secrets ds where ds.id = v_secret;
  if v_secret_value is null then
    raise exception 'source signing secret could not be read' using errcode = '22023';
  end if;
  v_new_secret := vault.create_secret(
    v_secret_value,
    'webhook_sub:' || v_id::text || ':' || gen_random_uuid()::text,
    'Hive webhook signing secret (cloned destination)'
  );

  if v_auth is not null then
    select ds.decrypted_secret into v_auth_value from vault.decrypted_secrets ds where ds.id = v_auth;
    if v_auth_value is null then
      raise exception 'source bearer token could not be read' using errcode = '22023';
    end if;
    v_new_auth := vault.create_secret(
      v_auth_value,
      'webhook_auth:' || v_id::text || ':' || gen_random_uuid()::text,
      'Hive webhook bearer token (cloned destination)'
    );
  end if;

  insert into public.webhook_subscriptions (
    id, agent_name, url, secret_id, event_types, filters, enabled, auth_token_secret_id
  ) values (
    v_id,
    p_new_agent,
    v_url,
    v_new_secret,
    p_event_types,
    p_filters,
    coalesce(p_enabled, true),
    v_new_auth
  );

  return v_id;
end
$$;

revoke all on function public.hive_clone_webhook_destination(text, text, text[], jsonb, boolean) from public, anon, authenticated;
grant execute on function public.hive_clone_webhook_destination(text, text, text[], jsonb, boolean) to service_role;

-- 2) STAR 50 and ChiNext index symbols. SH000300 is already seeded; keep it enabled.
--    enabled and ths_auction are not reset on a rerun except we turn these index rows on.
insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol, enabled, ths_code, ths_kind)
values
  ('SH000688', null, null, true, '000688.SH', 'index'),
  ('SZ399006', null, null, true, '399006.SZ', 'index')
on conflict (symbol) do update
   set ths_code = excluded.ths_code,
       ths_kind = excluded.ths_kind,
       enabled = true,
       updated_at = now();

update public.symbol_map
   set enabled = true,
       ths_code = coalesce(ths_code, '000300.SH'),
       ths_kind = coalesce(ths_kind, 'index'),
       updated_at = now()
 where symbol = 'SH000300';

-- 3) Conservative 5m volume_spike rules. Confirmed bars only (evaluator). Skip the
--    09:30 Asia/Shanghai open bar (mechanical volume vs the previous afternoon
--    average). Require a 0.3% bar body so a flat open print cannot fire.
--    Thresholds match the existing SH513310 rule: 2x, lookback 20, 30-minute cooldown.
--    Source sina; these rules do nothing until 5m candles exist (collector whitelist).
insert into public.alert_rules (name, symbol, source, kind, params, cooldown_seconds, enabled)
select v.name, v.symbol, 'sina', 'volume_spike',
       '{"interval":"5m","lookback":20,"multiple":2,"minMovePct":0.3,"skipSessionOpenBars":1}'::jsonb,
       1800, true
  from (values
    ('SH000688 5m volume >=2x, skip open, min move 0.3%', 'SH000688'),
    ('SZ399006 5m volume >=2x, skip open, min move 0.3%', 'SZ399006'),
    ('SH000300 5m volume >=2x, skip open, min move 0.3%', 'SH000300')
  ) as v(name, symbol)
 where not exists (
   select 1 from public.alert_rules r
    where r.kind = 'volume_spike' and r.symbol = v.symbol and r.name = v.name
 );
