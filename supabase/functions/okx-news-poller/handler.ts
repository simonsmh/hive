import { isAuthorized } from "./core/auth.ts";
import { NewsFormatError, toIngestRows, type NewsIngestRow, type NewsItemInput } from "./core/news.ts";
import { OKX_NEWS_PATH, parseOkxNewsPage, type OkxNewsPage } from "./core/okx-news.ts";
import { type OkxCredentials, okxAuthHeaders } from "./core/okx-signing.ts";

export const DEFAULT_OKX_NEWS_CONFIG = { baseUrl: "https://www.okx.com" } as const;

export const PAGE_LIMIT = 50;
export const MAX_PAGES = 10;
/** Re-reads this far before the newest stored item, so items that appear late in the feed are still picked up. */
export const OVERLAP_MS = 10 * 60_000;
/** Caps how far back a poll reaches after an outage or on an empty table. */
export const LOOKBACK_MS = 2 * 60 * 60_000;

export interface OkxNewsConfig {
  baseUrl: string;
  /** The endpoint rejects unsigned requests (OK-ACCESS-KEY). When absent, requests are sent unsigned and fail with OKX's message. */
  credentials?: OkxCredentials;
}

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

export interface OkxNewsStore {
  latestPublishedAt(): Promise<string | null>;
  ingest(rows: NewsIngestRow[]): Promise<IngestResult>;
  recordFailure(error: string): Promise<void>;
}

export interface OkxNewsDeps {
  cronSecret: string | undefined;
  store: OkxNewsStore;
  config: OkxNewsConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

const MAX_ERROR_LENGTH = 300;
const MAX_DETAIL_LENGTH = 120;

/** An upstream failure whose message is already safe to store on source_health. */
class UpstreamError extends Error {}

/**
 * Start of the poll window: the newest stored item minus the overlap. The anchor is clamped to [now - LOOKBACK, now],
 * so an empty table, a long outage, or a future timestamp cannot produce an unbounded or empty window.
 */
export function windowStart(latestPublishedAt: string | null, nowMs: number): number {
  const floor = nowMs - LOOKBACK_MS;
  const parsed = latestPublishedAt === null ? Number.NaN : Date.parse(latestPublishedAt);
  const anchor = Math.min(Math.max(Number.isNaN(parsed) ? floor : parsed, floor), nowMs);
  return anchor - OVERLAP_MS;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/** OKX error bodies are {"code","msg"}. The msg is kept, since it says whether the key was missing or rejected. */
function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const msg = asRecord(JSON.parse(body))?.msg;
    if (typeof msg === "string") detail = msg.trim().slice(0, MAX_DETAIL_LENGTH);
  } catch {
    detail = "";
  }
  return detail === "" ? `okx-news HTTP ${status}` : `okx-news HTTP ${status}: ${detail}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Polls OKX Orbit high-importance news for the window [windowStart, now], paging backwards with end = oldest - 1
 * while pages are full. Every page is fetched before anything is written. If any page fails, nothing is ingested
 * and the watermark is unchanged, so the next run retries the same window.
 */
export function createOkxNewsHandler(deps: OkxNewsDeps): (request: Request) => Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[okx-news-poller] ${message}`));

  const recordFailure = async (message: string): Promise<void> => {
    await deps.store.recordFailure(message).catch((error: unknown) => {
      log(`could not record failure: ${describeError(error)}`);
    });
  };

  const degrade = async (message: string): Promise<Response> => {
    await recordFailure(message);
    log(message);
    return json(200, { status: "degraded", error: message });
  };

  const fetchPage = async (beginMs: number, endMs: number): Promise<OkxNewsPage> => {
    const url = new URL(OKX_NEWS_PATH, deps.config.baseUrl);
    url.search = new URLSearchParams({
      sortBy: "latest",
      importance: "high",
      begin: String(Math.floor(beginMs)),
      end: String(Math.floor(endMs)),
      limit: String(PAGE_LIMIT),
      acceptLanguage: "en_US",
    }).toString();

    const headers: Record<string, string> = { accept: "application/json" };
    if (deps.config.credentials) {
      Object.assign(
        headers,
        await okxAuthHeaders(deps.config.credentials, "GET", `${url.pathname}${url.search}`, new Date(now()).toISOString()),
      );
    }

    const response = await fetchImpl(url, { method: "GET", headers });
    const text = await response.text();
    if (!response.ok) throw new UpstreamError(describeHttpError(response.status, text));

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new UpstreamError("okx-news response is not JSON (blocked, or the endpoint changed)");
    }
    return parseOkxNewsPage(payload, now());
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const started = now();

    let beginMs: number;
    try {
      beginMs = windowStart(await deps.store.latestPublishedAt(), started);
    } catch (error) {
      return degrade(`okx-news watermark failed: ${describeError(error)}`);
    }

    const collected = new Map<string, NewsItemInput>();
    let endMs = started;
    let pages = 0;
    let truncated = false;
    try {
      for (;;) {
        const page = await fetchPage(beginMs, endMs);
        pages += 1;
        for (const item of page.items) {
          if (!collected.has(item.externalId)) collected.set(item.externalId, item);
        }
        if (page.rawCount < PAGE_LIMIT || page.oldestMs === null || page.oldestMs - 1 <= beginMs) break;
        if (pages >= MAX_PAGES) {
          truncated = true;
          break;
        }
        endMs = page.oldestMs - 1;
      }
    } catch (error) {
      const message =
        error instanceof UpstreamError || error instanceof NewsFormatError
          ? error.message
          : `okx-news request failed: ${describeError(error)}`;
      return degrade(message);
    }

    if (truncated) log(`okx-news reached ${MAX_PAGES} pages; items older than the last page were not fetched`);

    const items = [...collected.values()];
    try {
      const result = await deps.store.ingest(toIngestRows(items));
      log(`ok pages=${pages} fetched=${items.length} inserted=${result.inserted} duplicates=${result.duplicates} ms=${now() - started}`);
      return json(200, {
        status: "ok",
        pages,
        fetched: items.length,
        ...result,
        truncated,
        durationMs: now() - started,
      });
    } catch (error) {
      return degrade(`okx-news ingest failed: ${describeError(error)}`);
    }
  };
}
