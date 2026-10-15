-- source_health is keyed by market_source, so the Google Finance earnings collector needs its own value there. The
-- value is added in its own migration because a new enum value cannot be used in the transaction that adds it.
alter type public.market_source add value if not exists 'google-finance-earnings';
