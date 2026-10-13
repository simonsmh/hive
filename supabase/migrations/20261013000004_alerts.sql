create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[a-z0-9_-]{1,64}$'),
  url text not null check (url ~ '^https://'),
  -- Signing secret lives in Vault (vault.secrets); this column only references it.
  secret_id uuid references vault.secrets (id) on delete set null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) > 0),
  symbol text not null references public.symbol_map (symbol) on delete cascade,
  source public.market_source not null default 'okx',
  kind text not null check (kind in ('price_cross', 'candle_close_break', 'volume_spike', 'long_wick', 'pullback')),
  params jsonb not null default '{}'::jsonb,
  cooldown_seconds integer not null default 300 check (cooldown_seconds >= 0),
  enabled boolean not null default true,
  webhook_id uuid references public.webhooks (id) on delete set null,
  last_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index alert_rules_symbol_enabled_idx on public.alert_rules (symbol) where enabled;

create table public.alerts (
  id bigint generated always as identity primary key,
  dedup_key text not null unique,
  rule_id uuid references public.alert_rules (id) on delete set null,
  symbol text,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  triggered_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index alerts_rule_triggered_idx on public.alerts (rule_id, triggered_at desc);

create table public.deliveries (
  id bigint generated always as identity primary key,
  alert_id bigint not null references public.alerts (id) on delete cascade,
  webhook_id uuid not null references public.webhooks (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'sending', 'delivered', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  response_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alert_id, webhook_id)
);
create index deliveries_status_next_idx on public.deliveries (status, next_attempt_at);
