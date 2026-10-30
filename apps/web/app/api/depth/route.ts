import { authorize, errorResponse, handle, jsonResponse } from "../../../lib/api";
import { parseBooleanFlag } from "../../../lib/params";
import { fetchDepthQuote, JQKA_SOURCE, parseAshareCodes, type JqkaDepthQuote } from "../../../lib/jqka";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/depth?symbols=513310,600487&minute=true
 *
 * Live A-share depth quotes from the JQKA (Tonghuashun public) source.
 * Same auth as /api/quote (HIVE_API_TOKEN Bearer, or dashboard session).
 * No database, no migration, no symbol_map change: this is a live upstream
 * read, and it does not touch the ths-collector's paid source ("ths").
 *
 * minute=false (default): quote fields only, so responses stay small.
 * minute=true: each quote also carries its full intraday minute series
 * (time/price/volume) as raw material for future trend capture; no trend
 * calculation is done here.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const url = new URL(request.url);
    const codes = parseAshareCodes(url.searchParams.get("symbols"));
    const includeMinute = parseBooleanFlag(url.searchParams.get("minute"), "minute") ?? false;

    const results = await Promise.all(codes.map((code) => fetchDepthQuote(code, { includeMinute })));
    const quotes: JqkaDepthQuote[] = [];
    const errors: { symbol: string; error: string }[] = [];
    results.forEach((result, index) => {
      if (result.quote) quotes.push(result.quote);
      else errors.push({ symbol: codes[index] as string, error: result.error ?? "upstream unavailable" });
    });

    if (quotes.length === 0 && errors.length > 0) {
      // Upstream failure, mapped generically; the raw upstream body is
      // never echoed (see lib/jqka.ts).
      return errorResponse(502, "upstream unavailable");
    }

    return jsonResponse({
      source: JQKA_SOURCE,
      quotes,
      errors,
      missing: errors.map((e) => e.symbol),
    });
  });
}
