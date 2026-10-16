import { isThsCode } from "./core/ths.ts";
import type { ThsCollectorStore } from "./handler.ts";
import type { ThsTarget } from "./core/ths-cycle.ts";
import type { Source } from "./core/types.ts";

export const SOURCE = "ths" as const;
const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface SymbolRow {
  symbol: string;
  ths_code: string | null;
  ths_kind: string | null;
  ths_auction: boolean | null;
}

/**
 * PostgREST-backed store. Reads use the service role. Writes go through the hive_collector_* functions, which
 * hold the same statements as the okx-collector path, plus the ths daily-snapshot function.
 */
export function createRestThsStore(options: RestStoreOptions): ThsCollectorStore {
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
    async isSourceEnabled() {
      const rows = (await request("GET", "/rest/v1/source_health?select=enabled&source=eq.ths")) as Array<{ enabled: boolean }>;
      return rows[0]?.enabled === true;
    },

    async listTargets(): Promise<ThsTarget[]> {
      const rows = (await request(
        "GET",
        "/rest/v1/symbol_map?select=symbol,ths_code,ths_kind,ths_auction&ths_code=not.is.null&enabled=eq.true&order=symbol",
      )) as SymbolRow[];
      const targets: ThsTarget[] = [];
      for (const row of rows) {
        if (!row.ths_code || !isThsCode(row.ths_code)) continue;
        if (row.ths_kind !== "stock" && row.ths_kind !== "index") continue;
        targets.push({ symbol: row.symbol, thscode: row.ths_code, kind: row.ths_kind, auction: row.ths_auction === true });
      }
      return targets;
    },

    async upsertQuote(symbol: string, source: Source, quote: { symbol: string; price: number; ts: number }) {
      await rpc("hive_collector_upsert_quote", {
        p_symbol: symbol,
        p_source: source,
        p_price: quote.price,
        p_ts_ms: quote.ts,
      });
    },

    async upsertDailySnapshot(date: string, kind: string, payload: Record<string, unknown>) {
      await rpc("hive_collector_upsert_daily_snapshot", { p_date: date, p_kind: kind, p_payload: payload });
    },

    async snapshotExists(date: string, kind: string) {
      const query = new URLSearchParams({ select: "kind", snapshot_date: `eq.${date}`, kind: `eq.${kind}`, limit: "1" });
      const rows = (await request("GET", `/rest/v1/daily_snapshot?${query.toString()}`)) as unknown[];
      return rows.length > 0;
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
