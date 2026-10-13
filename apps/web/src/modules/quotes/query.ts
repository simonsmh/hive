import "server-only";
import { assertNoError, getDb } from "@/lib/supabase";
import type { CandleRow, QuoteRow } from "./mapper";

/** The dashboard shows the OKX perpetual feed, which is the only source phase 1 writes. */
export const DASHBOARD_SOURCE = "okx";
export const CANDLE_HISTORY = 60;

export async function loadEnabledSymbols(): Promise<string[]> {
  const { data, error } = await getDb().from("symbol_map").select("symbol").eq("enabled", true).order("symbol");
  assertNoError(error);
  return ((data ?? []) as { symbol: string }[]).map((row) => row.symbol);
}

export async function loadLatestQuotes(symbols: readonly string[]): Promise<QuoteRow[]> {
  if (symbols.length === 0) return [];
  const { data, error } = await getDb()
    .from("quotes_latest")
    .select("symbol, price, ts")
    .eq("source", DASHBOARD_SOURCE)
    .in("symbol", [...symbols]);
  assertNoError(error);
  return (data ?? []) as QuoteRow[];
}

/** Daily bars are stored with interval `1D` (UTC day boundaries). Returned oldest first. */
export async function loadDailyCandles(symbol: string): Promise<CandleRow[]> {
  const { data, error } = await getDb()
    .from("candles")
    .select("ts, open, high, low, close, confirmed")
    .eq("symbol", symbol)
    .eq("source", DASHBOARD_SOURCE)
    .eq("interval", "1D")
    .order("ts", { ascending: false })
    .limit(CANDLE_HISTORY);
  assertNoError(error);
  return ((data ?? []) as CandleRow[]).reverse();
}
