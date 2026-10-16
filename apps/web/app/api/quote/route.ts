import { authorize, handle, jsonResponse } from "../../../lib/api";
import { getDb, assertNoError } from "../../../lib/supabase";
import { parseSource, parseSymbols } from "../../../lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const url = new URL(request.url);
    const symbols = parseSymbols(url.searchParams.get("symbols"));
    const source = parseSource(url.searchParams.get("source"));

    const { data, error } = await getDb()
      .from("quotes_latest")
      .select("symbol, price, ts")
      .eq("source", source)
      .in("symbol", symbols);
    assertNoError(error);

    const rows = (data ?? []) as { symbol: string; price: number; ts: string }[];
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    return jsonResponse({
      source,
      quotes: symbols.flatMap((s) => {
        const row = bySymbol.get(s);
        return row ? [row] : [];
      }),
      missing: symbols.filter((s) => !bySymbol.has(s)),
    });
  });
}
