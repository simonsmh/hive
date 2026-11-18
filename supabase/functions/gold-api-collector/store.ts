import { SOURCE } from "./handler.ts";
import type { GoldApiCollectorStore } from "./handler.ts";

const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only ever sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

export function createRestGoldApiStore(options: RestStoreOptions): GoldApiCollectorStore {
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
    async upsertQuote(symbol, source, quote) {
      await rpc("hive_collector_upsert_quote", {
        p_symbol: symbol,
        p_source: source,
        p_price: quote.price,
        p_ts_ms: quote.ts,
      });
    },
    async recordSourceSuccess(source) {
      await rpc("hive_collector_record_success", { p_source: source });
    },
    async recordSourceFailure(source, error) {
      await rpc("hive_collector_record_failure", { p_source: source, p_error: error.slice(0, MAX_ERROR_LENGTH) });
    },
  };
}
