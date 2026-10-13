create table public.news_events (
  id uuid primary key default gen_random_uuid(),
  earliest_item_id bigint,
  title text,
  first_published_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.news_items (
  id bigint generated always as identity primary key,
  source text not null check (length(source) > 0),
  title text,
  url text not null,
  body text,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  dedup_hash text not null unique,
  event_id uuid references public.news_events (id) on delete set null,
  credibility numeric check (credibility between 0 and 1),
  score numeric,
  created_at timestamptz not null default now()
);

alter table public.news_events
  add constraint news_events_earliest_item_fk
  foreign key (earliest_item_id) references public.news_items (id) deferrable initially deferred;

create index news_items_event_id_idx on public.news_items (event_id);
create index news_items_source_published_idx on public.news_items (source, published_at desc);
create index news_items_published_idx on public.news_items (published_at desc);

create table public.fills (
  id bigint generated always as identity primary key,
  exchange text not null default 'okx',
  kind text not null check (kind in ('fill', 'algo_order')),
  external_id text not null,
  inst_id text not null,
  side text check (side in ('buy', 'sell')),
  price numeric,
  size numeric,
  fee numeric,
  fee_ccy text,
  event_ts timestamptz not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (exchange, kind, external_id)
);
create index fills_inst_event_idx on public.fills (inst_id, event_ts desc);
