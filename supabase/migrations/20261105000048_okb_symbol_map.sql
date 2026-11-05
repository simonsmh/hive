-- Add OKB to symbol_map so the OKX collector universe covers it.
--
-- BTC / ETH / SOL are already in symbol_map (enabled, with their
-- *-USDT-SWAP instIds); OKB was the only one of the four new instant-trend
-- OKX symbols missing. The instant-trend panel itself reads the hardcoded
-- MA_DEVIATION_SYMBOLS list (not symbol_map), but the okx-collector only
-- polls symbols that are in symbol_map, so without this row OKB would be
-- visible on the panel yet absent from the candles table the rest of Hive
-- reads. Approved by the user 2026-11-05 evening (instant trend: add
-- BTC / ETH / SOL / OKB to the OKX side).
insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol, enabled)
values ('OKB', 'OKB-USDT-SWAP', 'OKB-USD', true)
on conflict (symbol) do update set
  okx_inst_id = excluded.okx_inst_id,
  yahoo_symbol = excluded.yahoo_symbol,
  enabled = true;
