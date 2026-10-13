-- ETH was missing from the symbol_map seed, so it never resolved to an OKX instrument and
-- /api/quote reported it as missing. Matches DEFAULT_SYMBOLS in packages/core.
insert into public.symbol_map (symbol, okx_inst_id, yahoo_symbol) values
  ('ETH', 'ETH-USDT-SWAP', 'ETH-USD')
on conflict (symbol) do nothing;
