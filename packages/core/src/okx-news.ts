import { NewsFormatError, stripMarkup, type NewsItemInput } from "./news.js";

/** OKX Orbit news search, normalised into news items for the hive_news_ingest RPC. Pure: no I/O. */

export const OKX_NEWS_SOURCE = "okx-news" as const;
export const OKX_NEWS_PATH = "/api/v5/orbit/news-search";
const OKX_NEWS_POST_BASE = "https://www.okx.com/zh-hans/feed/post/";

const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 4000;
const MAX_AUTHOR_LENGTH = 120;
const MAX_EXTERNAL_ID_LENGTH = 128;
/** A cTime below this is not milliseconds since 1970 in any plausible range (1e11 ms is 1973). */
const MIN_CTIME_MS = 1e11;

export interface OkxNewsPage {
  items: NewsItemInput[];
  /** Entries in the raw page before filtering. The request limit applies to this count, so pagination uses it. */
  rawCount: number;
  /** Smallest valid cTime (ms) in the raw page, or null when no entry carries one. */
  oldestMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseCTime(value: unknown): number | null {
  const ms = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(ms) && ms >= MIN_CTIME_MS ? Math.floor(ms) : null;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" ? stripMarkup(value) : "";
    if (text !== "") return text;
  }
  return "";
}

/** duplicateAuthors is not documented. Accepts strings or objects with a name, de-duplicated and joined. */
function parseAuthors(value: unknown): string | null {
  const names = new Set<string>();
  for (const entry of Array.isArray(value) ? value : [value]) {
    const name = (typeof entry === "string" ? entry : asText(asRecord(entry)?.name))?.trim();
    if (name) names.add(name);
  }
  return names.size === 0 ? null : [...names].join(", ").slice(0, MAX_AUTHOR_LENGTH);
}

function toItem(raw: Record<string, unknown>, publishedMs: number): NewsItemInput | null {
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id).trim() : "";
  if (id === "" || id.length > MAX_EXTERNAL_ID_LENGTH) return null;

  const importance = asText(raw.importance);
  if (importance !== null && importance.trim().toLowerCase() !== "high") return null;

  const body = firstNonEmpty(raw.content, raw.summary);
  if (body === "") return null;

  const title = firstNonEmpty(raw.title);
  const sourceUrl = asText(raw.sourceUrl)?.trim() ?? "";

  return {
    source: OKX_NEWS_SOURCE,
    externalId: id,
    title: title === "" ? null : title.slice(0, MAX_TITLE_LENGTH),
    body: body.slice(0, MAX_BODY_LENGTH),
    url: isHttpUrl(sourceUrl) ? sourceUrl : `${OKX_NEWS_POST_BASE}${encodeURIComponent(id)}`,
    author: parseAuthors(raw.duplicateAuthors),
    publishedAt: new Date(publishedMs).toISOString(),
    important: true,
  };
}

/**
 * Parses one `news-search` page. The endpoint's envelope is `{ details: [...], nextCursor }`. Pagination is driven by
 * the caller through `end`, so nextCursor is not read. Entries without an id, content or a high importance are
 * skipped. A missing details array, a non-zero `code`, or a non-empty page with nothing usable throws NewsFormatError.
 */
export function parseOkxNewsPage(payload: unknown, nowMs: number = Date.now()): OkxNewsPage {
  const root = asRecord(payload);
  if (root === null) throw new NewsFormatError("okx-news response is not an object");

  const code = root.code;
  if (code !== undefined && code !== null && String(code) !== "0") {
    throw new NewsFormatError(`okx-news returned code ${String(code).slice(0, 20)}`);
  }

  const details = root.details;
  if (!Array.isArray(details)) throw new NewsFormatError("okx-news response has no details array");

  const items: NewsItemInput[] = [];
  let oldestMs: number | null = null;
  for (const entry of details) {
    const raw = asRecord(entry);
    if (raw === null) continue;
    const ms = parseCTime(raw.cTime);
    if (ms !== null && (oldestMs === null || ms < oldestMs)) oldestMs = ms;
    const item = toItem(raw, ms ?? nowMs);
    if (item !== null) items.push(item);
  }

  if (details.length > 0 && items.length === 0) {
    throw new NewsFormatError("okx-news response contained no usable news items");
  }
  return { items, rawCount: details.length, oldestMs };
}
