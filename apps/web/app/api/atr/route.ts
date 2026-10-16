import { AtrInsufficientDataError, computeAtr, prepareBarsForSymbol, type OhlcBar } from "@hive/core";
import { authorize, errorResponse, handle, jsonResponse } from "../../../lib/api";
import { getDb, assertNoError } from "../../../lib/supabase";
import { parseInteger, parseSource, parseSymbol } from "../../../lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PERIOD = 100;
const HISTORY_BARS = 400;

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const symbol = parseSymbol(params.get("symbol"));
    const source = parseSource(params.get("source"));
    const period = parseInteger(params.get("period"), "period", 14, 1, MAX_PERIOD);

    // Only confirmed daily bars: the in-progress bar would skew the range.
    const { data, error } = await getDb()
      .from("candles")
      .select("ts, high, low, close")
      .eq("symbol", symbol)
      .eq("source", source)
      .eq("interval", "1D")
      .eq("confirmed", true)
      .order("ts", { ascending: false })
      .limit(HISTORY_BARS);
    assertNoError(error);

    const bars: OhlcBar[] = ((data ?? []) as { ts: string; high: number; low: number; close: number }[]).map((row) => ({
      ts: Date.parse(row.ts),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }));
    const prepared = prepareBarsForSymbol(symbol, bars);

    try {
      const result = computeAtr(prepared, period);
      return jsonResponse({
        symbol,
        source,
        interval: "1D",
        period,
        atr: result.atr,
        bars_used: result.barsUsed,
        weekday_only: symbol === "XAU",
        as_of: prepared.length > 0 ? new Date(prepared[prepared.length - 1]!.ts).toISOString() : null,
      });
    } catch (err) {
      if (err instanceof AtrInsufficientDataError) {
        return errorResponse(422, `not enough confirmed daily bars: need ${err.required}, have ${err.available}`);
      }
      throw err;
    }
  });
}
