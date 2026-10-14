-- OKX Orbit news reuses the news pipeline, which keys source_health by market_source. The value needs its own
-- migration so the seed in the next migration can use it (a new enum value is not usable in the adding transaction).
alter type public.market_source add value if not exists 'okx-news';
