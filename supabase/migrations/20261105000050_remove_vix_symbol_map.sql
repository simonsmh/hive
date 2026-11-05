-- Remove the VIX symbol_map row added by 20261105000049.
--
-- The user decided on 2026-11-05 evening (after PR #49 had already been
-- merged) not to add VIX to the instant-trend panel, so the row -- which
-- would have enrolled VIX in the yahoo-collector -- goes away too.
-- UVXY (added in the same migration) stays: it is an OKX perpetual in
-- the panel.
delete from public.symbol_map where symbol = 'VIX';

-- The yahoo-collector picked the row up tonight and wrote 1m VIX bars
-- (78 rows, all from 2026-11-05); remove those too. The 66 pre-existing
-- 1D VIX bars (back to 2026-08, from an older ingestion path) are left
-- alone -- they predate this batch.
delete from public.candles where symbol = 'VIX' and interval = '1m';
