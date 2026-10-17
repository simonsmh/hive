import "server-only";
import { guessYahooSymbol, OkxClient, pickSwapInstId, type SymbolAddItem } from "@hive/core";
import { assertNoError, getDb } from "@/lib/supabase";
import { toSymbolView, type SymbolRow, type SymbolView } from "./mapper";

const SYMBOL_COLUMNS = "symbol, okx_inst_id, yahoo_symbol, ths_code, ths_kind, ths_auction, enabled, updated_at";

export async function listSymbolViews(): Promise<SymbolView[]> {
  const { data, error } = await getDb().from("symbol_map").select(SYMBOL_COLUMNS).order("symbol");
  assertNoError(error);
  return ((data ?? []) as SymbolRow[]).map(toSymbolView);
}

/** instId -> symbol for every row that names an OKX instrument; drives the universe ranking's tracked flags. */
export async function loadSymbolByInstId(): Promise<Map<string, string>> {
  const { data, error } = await getDb().from("symbol_map").select("symbol, okx_inst_id").not("okx_inst_id", "is", null);
  assertNoError(error);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as { symbol: string; okx_inst_id: string }[]) {
    map.set(row.okx_inst_id, row.symbol);
  }
  return map;
}

export interface SymbolAddOutcome {
  symbol: string;
  /** created: a new row; updated: an existing row whose mappings were merged and re-enabled. */
  action: "created" | "updated";
  view: SymbolView;
}

/**
 * Adds (or re-enables and merges) symbol_map rows. An omitted okx_inst_id is
 * resolved against the live OKX instrument list, so a bare symbol starts
 * collecting on the next collector tick; an omitted yahoo_symbol is filled
 * with the mechanical guess. A symbol OKX does not list still lands as a
 * row (THS-only symbols take that path) but reports resolved=false.
 */
export async function addSymbols(items: SymbolAddItem[]): Promise<(SymbolAddOutcome & { okx_resolved: boolean })[]> {
  const needsResolution = items.some((item) => item.okx_inst_id === null && item.ths_code === null);
  let instruments: Awaited<ReturnType<OkxClient["getInstruments"]>> | null = null;
  if (needsResolution) {
    try {
      instruments = await new OkxClient().getInstruments("SWAP");
    } catch {
      instruments = null; // Resolution is best-effort; the collector re-resolves null instIds itself.
    }
  }

  const db = getDb();
  const { data: existing, error: readError } = await db
    .from("symbol_map")
    .select(SYMBOL_COLUMNS)
    .in("symbol", items.map((item) => item.symbol));
  assertNoError(readError);
  const existingBySymbol = new Map(((existing ?? []) as SymbolRow[]).map((row) => [row.symbol, row]));

  const outcomes: (SymbolAddOutcome & { okx_resolved: boolean })[] = [];
  for (const item of items) {
    const prior = existingBySymbol.get(item.symbol);
    const resolvedInstId =
      item.okx_inst_id ?? prior?.okx_inst_id ?? (instruments ? pickSwapInstId(item.symbol, instruments) : null);
    const row = {
      symbol: item.symbol,
      okx_inst_id: resolvedInstId,
      yahoo_symbol: item.yahoo_symbol ?? prior?.yahoo_symbol ?? guessYahooSymbol(item.symbol),
      ths_code: item.ths_code ?? prior?.ths_code ?? null,
      ths_kind: item.ths_kind ?? prior?.ths_kind ?? null,
      enabled: true,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await db.from("symbol_map").upsert(row, { onConflict: "symbol" }).select(SYMBOL_COLUMNS).single();
    if (error) {
      if (error.code === "23505") {
        throw new Error(`okx_inst_id ${row.okx_inst_id} is already tracked under another symbol`);
      }
      assertNoError(error);
    }
    outcomes.push({
      symbol: item.symbol,
      action: prior ? "updated" : "created",
      okx_resolved: row.okx_inst_id !== null,
      view: toSymbolView(data as SymbolRow),
    });
  }
  return outcomes;
}

/** Deletes symbol_map rows outright. Candle history is kept and ages out under the retention policy. */
export async function removeSymbols(symbols: string[]): Promise<string[]> {
  const db = getDb();
  const { data, error } = await db.from("symbol_map").delete().in("symbol", symbols).select("symbol");
  assertNoError(error);
  return ((data ?? []) as { symbol: string }[]).map((row) => row.symbol);
}

export async function setSymbolsEnabled(symbols: string[], enabled: boolean): Promise<SymbolView[]> {
  const { data, error } = await getDb()
    .from("symbol_map")
    .update({ enabled, updated_at: new Date().toISOString() })
    .in("symbol", symbols)
    .select(SYMBOL_COLUMNS);
  assertNoError(error);
  return ((data ?? []) as SymbolRow[]).map(toSymbolView);
}
