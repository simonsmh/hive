create type public.market_source as enum ('okx', 'yahoo', 'sina', 'ths', 'google');

create table public.symbol_map (
  symbol text primary key check (symbol ~ '^[A-Z0-9]{1,20}$'),
  okx_inst_id text unique,
  yahoo_symbol text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.candles (
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,20}$'),
  source public.market_source not null,
  interval text not null check (interval in ('1m', '5m', '15m', '1H', '1D')),
  ts timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric not null default 0,
  vol_ccy numeric not null default 0,
  confirmed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (symbol, source, interval, ts),
  check (high >= low)
);
create index candles_source_interval_ts_idx on public.candles (source, interval, ts desc);
create index candles_confirmed_daily_idx on public.candles (symbol, source, ts desc) where confirmed and interval = '1D';

create table public.quotes_latest (
  symbol text not null,
  source public.market_source not null,
  price numeric not null check (price > 0),
  ts timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (symbol, source)
);

create table public.daily_snapshot (
  snapshot_date date not null,
  kind text not null check (length(kind) > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_date, kind)
);

create table public.source_health (
  source public.market_source primary key,
  enabled boolean not null default false,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  max_staleness_minutes integer not null default 10 check (max_staleness_minutes > 0),
  last_error text,
  updated_at timestamptz not null default now()
);

insert into public.source_health (source, enabled, max_staleness_minutes) values
  ('okx', true, 3),
  ('yahoo', false, 30),
  ('sina', false, 30),
  ('ths', false, 30),
  ('google', false, 30);

-- Yahoo symbols are used for US/spot reference prices in the spread view.
-- Phase 1 only polls OKX; the okx_inst_id column is refreshed by the worker.
insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol) values
  ('BZ', 'BZ-USDT-SWAP', 'BZ=F'),
  ('SNDK', 'SNDK-USDT-SWAP', 'SNDK'),
  ('MU', 'MU-USDT-SWAP', 'MU'),
  ('META', 'META-USDT-SWAP', 'META'),
  ('NVDA', 'NVDA-USDT-SWAP', 'NVDA'),
  ('QQQ', 'QQQ-USDT-SWAP', 'QQQ'),
  ('MRNA', 'MRNA-USDT-SWAP', 'MRNA'),
  ('TSM', 'TSM-USDT-SWAP', 'TSM'),
  ('XAU', 'XAU-USDT-SWAP', 'XAUUSD=X'),
  ('BTC', 'BTC-USDT-SWAP', 'BTC-USD')
on conflict (symbol) do nothing;

-- Spread between the US/spot reference (yahoo) and the OKX perpetual, per mapped symbol.
-- Rows appear once both sources have a quote; phase 1 only populates okx.
create view public.v_spread with (security_invoker = true) as
select
  m.symbol,
  m.okx_inst_id,
  m.yahoo_symbol,
  s.price as spot_price,
  s.ts as spot_ts,
  p.price as perp_price,
  p.ts as perp_ts,
  p.price - s.price as spread,
  round((p.price - s.price) / nullif(s.price, 0) * 100, 4) as spread_pct
from public.symbol_map m
join public.quotes_latest s on s.symbol = m.symbol and s.source = 'yahoo'
join public.quotes_latest p on p.symbol = m.symbol and p.source = 'okx';
