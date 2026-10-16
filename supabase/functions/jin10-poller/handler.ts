import { isAuthorized } from "./core/auth.ts";
import { NewsFormatError, parseJin10FlashList, toIngestRows, type NewsIngestRow } from "./core/news.ts";

/**
 * Jin10's flash endpoint is unofficial. The defaults mirror the public web client (x-app-id and x-version
 * are the values it sends to flash-api.jin10.com). Override them with Edge secrets if Jin10 rotates them.
 */
export const DEFAULT_JIN10_CONFIG = {
  url: "https://flash-api.jin10.com/get_flash_list",
  appId: "bVBF4FyRTn5NJF5n",
  version: "1.0.0",
  referer: "https://www.jin10.com/",
  query: "channel=-8200&vip=1",
} as const;

export type Jin10Config = { [K in keyof typeof DEFAULT_JIN10_CONFIG]: string };

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

export interface Jin10Store {
  ingest(rows: NewsIngestRow[]): Promise<IngestResult>;
  recordFailure(error: string): Promise<void>;
}

export interface Jin10Deps {
  cronSecret: string | undefined;
  store: Jin10Store;
  config: Jin10Config;
  fetchImpl?: typeof fetch;
  now?: () => number;
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
export function createJin10Handler(deps: Jin10Deps): (request: Request) => Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[jin10-poller] ${message}`));

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
    const url = `${deps.config.url}${deps.config.query ? `?${deps.config.query}` : ""}`;
    let payload: unknown;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-app-id": deps.config.appId,
          "x-version": deps.config.version,
          referer: deps.config.referer,
        },
      });
      const text = await response.text();
      if (!response.ok) {
        const message = `jin10 HTTP ${response.status}`;
        await recordFailure(message);
        log(message);
        return json(200, { status: "degraded", error: message });
      }
      try {
        payload = JSON.parse(text);
      } catch {
        const message = "jin10 response is not JSON (blocked, or the endpoint changed)";
        await recordFailure(message);
        log(message);
        return json(200, { status: "degraded", error: message });
      }
    } catch (error) {
      const message = `jin10 request failed: ${describeError(error)}`;
      await recordFailure(message);
      log(message);
      return json(200, { status: "degraded", error: message });
    }

    try {
      const items = parseJin10FlashList(payload, now());
      const result = await deps.store.ingest(toIngestRows(items));
      log(`ok fetched=${items.length} inserted=${result.inserted} duplicates=${result.duplicates} ms=${now() - started}`);
      return json(200, { status: "ok", fetched: items.length, ...result, durationMs: now() - started });
    } catch (error) {
      const message = error instanceof NewsFormatError ? error.message : `jin10 ingest failed: ${describeError(error)}`;
      await recordFailure(message);
      log(message);
      return json(200, { status: "degraded", error: message });
    }
  };
}
