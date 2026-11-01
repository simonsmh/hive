import { authorize, handle, jsonResponse, ParamError } from "../../../lib/api";
import { parseBooleanFlag, parseInteger, parseInterval, parseOneOf, parseSource, parseSymbols } from "../../../lib/params";
import { getDb, assertNoError } from "../../../lib/supabase";
import { smaSeries } from "@/src/modules/quotes/chart-math";
import {
  buildChartSvg,
  normalizeBars,
  parseMaPeriods,
  summarizeSeries,
  type ChartSeriesInput,
} from "@/src/modules/quotes/chart-svg";
import type { CandleBar } from "@/src/modules/quotes/mapper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 120;

/**
 * GET /api/chart — one SVG chart (plus per-series numbers) built only from the
 * candles table, so Muse can quote a chart without re-fetching an upstream or
 * re-implementing moving averages.
 *
 * Query: symbols (comma-separated, max 50), source (default okx), interval
 * (default 1D), limit (default 120, max 2000, same cap as /api/candles),
 * normalize (true = rescale every series so its first close is 100),
 * ma (comma-separated periods, e.g. 5,10,20,60, reusing chart-math smaSeries),
 * format (json default, or svg for a raw image/svg+xml body).
 *
 * Symbols with no candles for the requested source/interval are listed in
 * `missing`, never drawn from another source or silently dropped. `latest`
 * comes from quotes_latest for the requested source only: it is a live
 * snapshot, not the last candle close, and is null when that source has no
 * latest row (the sina collector, for example, writes candles but not
 * quotes_latest). `as_of` is the newest candle timestamp across the drawn
 * series, or null when nothing was drawn.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const symbols = parseSymbols(params.get("symbols"));
    const source = parseSource(params.get("source"));
    const intervalRaw = params.get("interval");
    const interval = intervalRaw === null || intervalRaw === "" ? "1D" : parseInterval(intervalRaw);
    const limit = parseInteger(params.get("limit"), "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
    const normalize = parseBooleanFlag(params.get("normalize"), "normalize") ?? false;
    const format = parseOneOf(params.get("format"), "format", ["json", "svg"] as const) ?? "json";
    let maPeriods: number[];
    try {
      maPeriods = parseMaPeriods(params.get("ma"));
    } catch (err) {
      throw new ParamError(err instanceof Error ? err.message : "invalid ma");
    }

    const db = getDb();
    const series: ChartSeriesInput[] = [];
    const summaries = [];
    const missing: string[] = [];

    for (const symbol of symbols) {
      const { data, error } = await db
        .from("candles")
        .select("ts, open, high, low, close, volume, confirmed")
        .eq("symbol", symbol)
        .eq("source", source)
        .eq("interval", interval)
        .order("ts", { ascending: false })
        .limit(limit);
      assertNoError(error);
      const rawBars: CandleBar[] = ((data ?? []) as Record<string, unknown>[])
        .map((row) => ({
          time: Date.parse(String(row.ts)),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
          confirmed: row.confirmed === true,
        }))
        .filter(
          (bar) =>
            Number.isFinite(bar.time) &&
            Number.isFinite(bar.open) &&
            Number.isFinite(bar.high) &&
            Number.isFinite(bar.low) &&
            Number.isFinite(bar.close) &&
            bar.close > 0,
        )
        .reverse();
      if (rawBars.length === 0) {
        missing.push(symbol);
        continue;
      }
      const displayBars = normalize ? normalizeBars(rawBars) : rawBars;
      if (displayBars === null) {
        // First close cannot anchor the normalized scale: do not draw it wrong.
        missing.push(symbol);
        continue;
      }
      const ma = maPeriods.map((period) => ({ period, values: smaSeries(displayBars, period) }));
      series.push({ symbol, bars: displayBars, ma });
      const summary = summarizeSeries(symbol, rawBars, maPeriods);
      const { data: latestRows, error: latestError } = await db
        .from("quotes_latest")
        .select("price, ts, source")
        .eq("symbol", symbol)
        .eq("source", source)
        .order("updated_at", { ascending: false })
        .limit(1);
      assertNoError(latestError);
      const latestRow = (latestRows ?? [])[0] as Record<string, unknown> | undefined;
      summaries.push({
        ...summary,
        latest:
          latestRow === undefined
            ? null
            : {
                price: Number(latestRow.price),
                ts: new Date(String(latestRow.ts)).toISOString(),
                source: String(latestRow.source),
              },
      });
    }

    const svg = buildChartSvg({ series, interval, normalize });
    const asOf =
      summaries.length > 0
        ? summaries.map((s) => s.last_ts!).sort().reverse()[0]!
        : null;

    if (format === "svg") {
      return new Response(svg, {
        headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return jsonResponse({
      symbols,
      source,
      interval,
      limit,
      normalize,
      ma: maPeriods,
      as_of: asOf,
      series: summaries,
      missing,
      latest_note:
        "latest is a live snapshot from quotes_latest for the requested source, not the last candle close; null when that source has no latest row.",
      svg,
    });
  });
}
