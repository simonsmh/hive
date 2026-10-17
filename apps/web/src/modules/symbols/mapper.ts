/** Row shape of public.symbol_map as selected by the API. */
export interface SymbolRow {
  symbol: string;
  okx_inst_id: string | null;
  yahoo_symbol: string | null;
  ths_code: string | null;
  ths_kind: string | null;
  ths_auction: boolean;
  enabled: boolean;
  updated_at: string;
}

export interface SymbolView {
  symbol: string;
  okx_inst_id: string | null;
  yahoo_symbol: string | null;
  ths_code: string | null;
  ths_kind: string | null;
  enabled: boolean;
  updated_at: string;
  /** Which collectors will pick this symbol up: every source whose mapping column is filled. */
  sources: string[];
}

export function toSymbolView(row: SymbolRow): SymbolView {
  const sources: string[] = [];
  if (row.okx_inst_id) sources.push("okx");
  if (row.yahoo_symbol) sources.push("yahoo");
  if (row.ths_code) sources.push("ths");
  return {
    symbol: row.symbol,
    okx_inst_id: row.okx_inst_id,
    yahoo_symbol: row.yahoo_symbol,
    ths_code: row.ths_code,
    ths_kind: row.ths_kind,
    enabled: row.enabled,
    updated_at: row.updated_at,
    sources,
  };
}
