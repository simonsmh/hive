-- source_health is keyed by market_source, so the news feed needs its own value there. A new enum value
-- cannot be used in the transaction that adds it, which is why the seed rows live in the next migration.
alter type public.market_source add value if not exists 'jin10';
