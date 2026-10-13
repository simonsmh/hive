import type { CollectorStore, QuoteRow, SymbolRecord } from "./core/collector.ts";
import type { Candle, Interval, Source } from "./core/types.ts";

export const SOURCE = "okx" as const;
const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface EdgeCollectorStore extends CollectorStore {
  listSymbols(): Promise<SymbolRecord[]>;
  setInstId(symbol: string, instId: string): Promise<void>;
  beginRun(holder: string, leaseSeconds: number): Promise<boolean>;
  finishRun(holder: string, outcome: string, backoffSeconds: number, summary: Record<string, unknown>): Promise<void>;
}

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role (or secret) key. Only ever sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface SymbolMapRow {
  symbol: string;
  okx_inst_id: string | null;
}

/**
 * PostgREST-backed collector store. Writes call the `hive_collector_*` SQL functions, which hold
 * the same statements as the worker's pg store, so both paths keep identical table semantics.
 */
export function createRestStore(options: RestStoreOptions): EdgeCollectorStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  async function request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, prefer?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (prefer) headers.prefer = prefer;

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
    async listSymbols() {
      const rows = (await request("GET", "/rest/v1/symbol_map?select=symbol,okx_inst_id&enabled=eq.true&order=symbol")) as SymbolMapRow[];
      return rows.map((row) => ({ symbol: row.symbol, okxInstId: row.okx_inst_id }));
    },

    async setInstId(symbol, instId) {
      await request(
        "PATCH",
        `/rest/v1/symbol_map?symbol=eq.${encodeURIComponent(symbol)}`,
        { okx_inst_id: instId, updated_at: now().toISOString() },
        "return=minimal",
      );
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
