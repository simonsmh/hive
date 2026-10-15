import type { FinhubSession } from "./core/google-finance.ts";
import type { EarningsStore, EarningsWatchRow, RecordBatch, RecordCounts } from "./handler.ts";

const SOURCE = "google-finance-earnings";
const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only ever sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface WatchRecord {
  google_symbol: string;
  symbol: string;
  is_primary: boolean;
  enabled: boolean;
  call_time: string | null;
  pre_minutes: number;
  post_minutes: number;
  finhub_bl: string | null;
  finhub_sid: string | null;
  finhub_refreshed_at: string | null;
  symbol_map: { okx_inst_id: string | null } | null;
}

const WATCH_SELECT =
  "select=google_symbol,symbol,is_primary,enabled,call_time,pre_minutes,post_minutes,finhub_bl,finhub_sid,finhub_refreshed_at,symbol_map(okx_inst_id)&order=google_symbol";

function toMs(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

/**
 * PostgREST-backed store. Writes go through hive_earnings_record (one transaction per poll) and the shared
 * hive_collector_* functions, so lease, backoff and source_health follow the same rules as the other collectors.
 */
export function createRestGoogleFinanceStore(options: RestStoreOptions): EarningsStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

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
    async listWatch(): Promise<EarningsWatchRow[]> {
      const rows = (await request("GET", `/rest/v1/earnings_watch?${WATCH_SELECT}`)) as WatchRecord[];
      return rows.map((row) => ({
        googleSymbol: row.google_symbol,
        symbol: row.symbol,
        isPrimary: row.is_primary,
        enabled: row.enabled,
        callTimeMs: toMs(row.call_time),
        preMinutes: row.pre_minutes,
        postMinutes: row.post_minutes,
        okxInstId: row.symbol_map?.okx_inst_id ?? null,
        session: { bl: row.finhub_bl, sid: row.finhub_sid },
        sessionRefreshedAtMs: toMs(row.finhub_refreshed_at),
      }));
    },

    async saveSession(googleSymbol: string, session: FinhubSession, refreshedAtMs: number): Promise<void> {
      await request(
        "PATCH",
        `/rest/v1/earnings_watch?google_symbol=eq.${encodeURIComponent(googleSymbol)}`,
        {
          finhub_bl: session.bl,
          finhub_sid: session.sid,
          finhub_refreshed_at: new Date(refreshedAtMs).toISOString(),
        },
        "return=minimal",
      );
    },

    async record(googleSymbol: string, symbol: string, batch: RecordBatch): Promise<RecordCounts> {
      const snapshot = batch.snapshot
        ? {
            payload_hash: batch.snapshot.payloadHash,
            cards: batch.snapshot.cards.map((card) => ({
              title: card.title,
              text: card.text,
              speaker: card.speaker,
              speaker_title: card.speakerTitle,
              company: card.company,
              offset_sec: card.offsetSec,
            })),
            key_numbers: batch.snapshot.findings,
            fetched_at: new Date(batch.snapshot.fetchedAtMs).toISOString(),
          }
        : null;
      const result = (await rpc("hive_earnings_record", {
        p_google_symbol: googleSymbol,
        p_symbol: symbol,
        p_snapshot: snapshot,
        p_segments: batch.segments.map((segment) => ({
          seg_hash: segment.hash,
          start_sec: segment.startSec,
          end_sec: segment.endSec,
          body: segment.text,
        })),
        p_alerts: batch.alerts.map((alert) => ({
          dedup_key: alert.dedupKey,
          symbol: alert.symbol,
          kind: alert.kind,
          severity: alert.severity,
          payload: alert.payload,
        })),
      })) as Partial<Record<"snapshots" | "segments" | "alerts", number>> | null;
      return {
        snapshots: Number(result?.snapshots ?? 0),
        segments: Number(result?.segments ?? 0),
        alerts: Number(result?.alerts ?? 0),
      };
    },

    async beginRun(holder: string, leaseSeconds: number): Promise<boolean> {
      return (await rpc("hive_collector_begin", { p_source: SOURCE, p_holder: holder, p_lease_seconds: leaseSeconds })) === true;
    },

    async finishRun(holder, outcome, backoffSeconds, summary): Promise<void> {
      await rpc("hive_collector_finish", {
        p_source: SOURCE,
        p_holder: holder,
        p_outcome: outcome,
        p_backoff_seconds: backoffSeconds,
        p_summary: summary,
      });
    },

    async recordSuccess(): Promise<void> {
      await rpc("hive_collector_record_success", { p_source: SOURCE });
    },

    async recordFailure(error: string): Promise<void> {
      await rpc("hive_collector_record_failure", { p_source: SOURCE, p_error: error.slice(0, MAX_ERROR_LENGTH) });
    },
  };
}
