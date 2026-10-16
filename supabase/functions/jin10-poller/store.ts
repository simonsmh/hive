import type { NewsIngestRow } from "./core/news.ts";
import type { IngestResult, Jin10Store } from "./handler.ts";

const SOURCE = "jin10";
const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

/** PostgREST RPC store. hive_news_ingest also refreshes the source heartbeat, so a poll with no new items still counts as healthy. */
export function createRestJin10Store(options: RestStoreOptions): Jin10Store {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: options.serviceKey,
        authorization: `Bearer ${options.serviceKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST ${name} returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    async ingest(rows: NewsIngestRow[]): Promise<IngestResult> {
      const result = (await rpc("hive_news_ingest", { p_source: SOURCE, p_items: rows })) as Partial<IngestResult> | null;
      return { inserted: Number(result?.inserted ?? 0), duplicates: Number(result?.duplicates ?? 0) };
    },

    async recordFailure(error: string): Promise<void> {
      await rpc("hive_collector_record_failure", { p_source: SOURCE, p_error: error.slice(0, MAX_ERROR_LENGTH) });
    },
  };
}
