import { authorize, handle, jsonResponse } from "../../../lib/api";
import { getDb, assertNoError } from "../../../lib/supabase";
import { parseInteger, parseInterval, parseSource, parseSymbol, parseTimestamp } from "../../../lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 500;

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const symbol = parseSymbol(params.get("symbol"));
    const source = parseSource(params.get("source"));
    const interval = parseInterval(params.get("interval"));
    const from = parseTimestamp(params.get("from"), "from");
    const to = parseTimestamp(params.get("to"), "to");
    const limit = parseInteger(params.get("limit"), "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);

    let query = getDb()
      .from("candles")
      .select("ts, open, high, low, close, volume, vol_ccy, confirmed")
      .eq("symbol", symbol)
      .eq("source", source)
      .eq("interval", interval);
    if (from) query = query.gte("ts", from);
    if (to) query = query.lte("ts", to);

    // With a `from` bound we return the earliest bars forward; otherwise the most recent `limit` bars.
    const ascending = from !== null;
    const { data, error } = await query.order("ts", { ascending }).limit(limit);
    assertNoError(error);

    const rows = (data ?? []) as Record<string, unknown>[];
    const candles = ascending ? rows : rows.reverse();
    return jsonResponse({ symbol, source, interval, count: candles.length, candles });
  });
}
