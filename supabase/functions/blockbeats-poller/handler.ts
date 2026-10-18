import { isAuthorized } from "./core/auth.ts";
import { NewsFormatError, parseBlockBeatsFlashList, toIngestRows, type NewsIngestRow } from "./core/news.ts";
import { BlockBeatsApiError, fetchBlockBeatsList, type BlockBeatsConfig } from "./api.ts";

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

export interface BlockBeatsStore {
  ingest(rows: NewsIngestRow[]): Promise<IngestResult>;
  recordFailure(error: string): Promise<void>;
}

export interface BlockBeatsDeps {
  cronSecret: string | undefined;
  store: BlockBeatsStore;
  config: BlockBeatsConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  log?: (message: string) => void;
}

const MAX_ERROR_LENGTH = 300;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/** Fetches one flash page and ingests it. Upstream failures are recorded on source_health and never throw. */
export function createBlockBeatsHandler(deps: BlockBeatsDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[blockbeats-poller] ${message}`));

  const recordFailure = async (message: string): Promise<void> => {
    await deps.store.recordFailure(message).catch((error: unknown) => {
      log(`could not record failure: ${describeError(error)}`);
    });
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const started = now();
    let payload: unknown;
    try {
      payload = await fetchBlockBeatsList({ config: deps.config, fetchImpl: deps.fetchImpl, now: deps.now, nonce: deps.nonce });
    } catch (error) {
      const message = error instanceof BlockBeatsApiError ? error.message : `blockbeats request failed: ${describeError(error)}`;
      await recordFailure(message);
      log(message);
      return json(200, { status: "degraded", error: message });
    }

    try {
      const items = parseBlockBeatsFlashList(payload, now());
      const result = await deps.store.ingest(toIngestRows(items));
      log(`ok fetched=${items.length} inserted=${result.inserted} duplicates=${result.duplicates} ms=${now() - started}`);
      return json(200, { status: "ok", fetched: items.length, ...result, durationMs: now() - started });
    } catch (error) {
      const message = error instanceof NewsFormatError ? error.message : `blockbeats ingest failed: ${describeError(error)}`;
      await recordFailure(message);
      log(message);
      return json(200, { status: "degraded", error: message });
    }
  };
}
