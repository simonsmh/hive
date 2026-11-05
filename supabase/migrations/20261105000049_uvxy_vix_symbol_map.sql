-- Add UVXY and VIX to symbol_map so the collector universes cover them.
--
-- UVXY (ProShares Ultra VIX Short-Term Futures ETF) has an OKX perpetual
-- (UVXY-USDT-SWAP) and a Yahoo quote (UVXY), so it is enrolled in both
-- the okx-collector and the yahoo-collector.
-- VIX is an index, not an OKX product: it has no okx_inst_id. Its
-- yahoo_symbol (^VIX) enrolls it in the yahoo-collector, which already
-- polls every enabled row with a yahoo_symbol; the instant-trend panel
-- reads VIX 1-minute bars live from Yahoo's v8 chart endpoint.
-- Approved by the user 2026-11-05 evening (instant trend: add UVXY and
-- VIX to the OKX group, together with BTC / ETH / SOL / OKB).
insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol, enabled)
values ('UVXY', 'UVXY-USDT-SWAP', 'UVXY', true)
on conflict (symbol) do update set
  okx_inst_id = excluded.okx_inst_id,
  yahoo_symbol = excluded.yahoo_symbol,
  enabled = true;

insert into public.symbol_map (symbol, yahoo_symbol, enabled)
values ('VIX', '^VIX', true)
on conflict (symbol) do update set
  yahoo_symbol = excluded.yahoo_symbol,
  enabled = true;
