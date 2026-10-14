import type { Candle } from "./core/types.ts";
import type { AlertInsert, AlertRuleRow, CandleRequest, EvaluatorStore, RecordResult } from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface AlertRuleDbRow {
  id: string;
  name: string;
  symbol: string;
  source: string;
  kind: string;
  params: unknown;
  cooldown_seconds: number;
  last_triggered_at: string | null;
}

interface CandleDbRow {
  ts: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
  vol_ccy: number | string;
}

/**
 * PostgREST-backed store. Reads use the service role against the alert_rules and candles tables. The only write is
 * hive_alert_evaluator_record, so inserts, dedup and last_triggered_at stay in one transaction, and the alerts
 * fan-out trigger runs there too.
 */
export function createRestEvaluatorStore(options: RestStoreOptions): EvaluatorStore {
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

  return {
    async listEnabledRules(): Promise<AlertRuleRow[]> {
      const rows = (await request(
        "GET",
        "/rest/v1/alert_rules?select=id,name,symbol,source,kind,params,cooldown_seconds,last_triggered_at&enabled=eq.true&order=name",
      )) as AlertRuleDbRow[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        symbol: row.symbol,
        source: row.source,
        kind: row.kind,
        params: row.params,
        cooldownSeconds: Number(row.cooldown_seconds),
        lastTriggeredAtMs: row.last_triggered_at ? Date.parse(row.last_triggered_at) : null,
      }));
    },

    async confirmedCandles({ symbol, source, interval, limit }: CandleRequest): Promise<Candle[]> {
      const query = new URLSearchParams({
        select: "ts,open,high,low,close,volume,vol_ccy",
        symbol: `eq.${symbol}`,
        source: `eq.${source}`,
        interval: `eq.${interval}`,
        confirmed: "eq.true",
        order: "ts.desc",
        limit: String(limit),
      });
      const rows = (await request("GET", `/rest/v1/candles?${query.toString()}`)) as CandleDbRow[];
      return rows
        .map((row): Candle => {
          const ts = Date.parse(row.ts);
          if (Number.isNaN(ts)) throw new Error(`candle ts is not a timestamp: ${row.ts}`);
          return {
            ts,
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume),
            volCcy: Number(row.vol_ccy),
            confirmed: true,
          };
        })
        .reverse();
    },

    async recordAlerts(alerts: AlertInsert[]): Promise<RecordResult> {
      const result = (await request("POST", "/rest/v1/rpc/hive_alert_evaluator_record", { p_alerts: alerts })) as
        | Partial<RecordResult>
        | null;
      return { inserted: Number(result?.inserted ?? 0), duplicates: Number(result?.duplicates ?? 0) };
    },
  };
}
