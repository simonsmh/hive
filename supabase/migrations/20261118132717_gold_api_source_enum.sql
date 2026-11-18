-- market_source value for the official Gold API live spot snapshot
-- (https://gold-api.com/docs). Must commit before any usage of 'gold-api'.
alter type public.market_source add value if not exists 'gold-api';
