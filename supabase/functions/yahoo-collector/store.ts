import type { QuoteRow } from "./core/collector.ts";
import type { Candle, Interval, Source } from "./core/types.ts";
import type { YahooCollectorStore, YahooSymbolRecord } from "./handler.ts";

export const SOURCE = "yahoo" as const;
const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only ever sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface SymbolMapRow {
  symbol: string;
  yahoo_symbol: string | null;
}

/**
 * PostgREST-backed store. Writes call the same `hive_collector_*` functions as okx-collector with p_source = 'yahoo',
 * so lease, backoff, quote guard, candle upsert and source_health follow one set of table semantics.
 */
export function createRestYahooStore(options: RestStoreOptions): YahooCollectorStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST ${method} ${path.split("?")[0]} returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  const rpc = (name: string, args: Record<string, unknown>) => request("POST", `/rest/v1/rpc/${name}`, args);

  return {
    async listSymbols(): Promise<YahooSymbolRecord[]> {
      const rows = (await request(
        "GET",
        "/rest/v1/symbol_map?select=symbol,yahoo_symbol&enabled=eq.true&yahoo_symbol=not.is.null&order=symbol",
      )) as SymbolMapRow[];
      return rows.map((row) => ({ symbol: row.symbol, yahooSymbol: row.yahoo_symbol }));
    },

    async upsertQuote(symbol: string, source: Source, quote: QuoteRow) {
      await rpc("hive_collector_upsert_quote", {
        p_symbol: symbol,
        p_source: source,
        p_price: quote.price,
        p_ts_ms: quote.ts,
      });
    },

    async upsertCandles(symbol: string, source: Source, interval: Interval, candles: readonly Candle[]) {
      if (candles.length === 0) return 0;
      const count = await rpc("hive_collector_upsert_candles", {
        p_symbol: symbol,
        p_source: source,
        p_interval: interval,
        p_candles: candles.map((c) => ({
          ts: c.ts,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          vol_ccy: c.volCcy,
          confirmed: c.confirmed,
        })),
      });
      return typeof count === "number" ? count : candles.length;
    },

    async recordSourceSuccess(source) {
      await rpc("hive_collector_record_success", { p_source: source });
    },

    async recordSourceFailure(source, error) {
      await rpc("hive_collector_record_failure", { p_source: source, p_error: error.slice(0, MAX_ERROR_LENGTH) });
    },

    async beginRun(holder, leaseSeconds) {
      return (await rpc("hive_collector_begin", { p_source: SOURCE, p_holder: holder, p_lease_seconds: leaseSeconds })) === true;
    },

    async finishRun(holder, outcome, backoffSeconds, summary) {
      await rpc("hive_collector_finish", {
        p_source: SOURCE,
        p_holder: holder,
        p_outcome: outcome,
        p_backoff_seconds: backoffSeconds,
        p_summary: summary,
      });
    },
  };
}
