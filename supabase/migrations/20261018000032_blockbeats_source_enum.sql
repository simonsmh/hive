-- BlockBeats flash news (1 of 2): the market_source enum value. Postgres forbids using a new enum
-- value in the same transaction that adds it, so the seed, the hive_news_ingest allowlist extension
-- and the cron schedule live in 20261018000033_blockbeats_news.sql. Same split as jin10 (11/12) and
-- okx-news (19/20).

alter type public.market_source add value if not exists 'blockbeats';
