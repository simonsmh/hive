// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import { NewsFormatError, stripMarkup, type NewsItemInput } from "./news.ts";

/** OKX Orbit news search, normalised into news items for the hive_news_ingest RPC. Pure: no I/O. */

export const OKX_NEWS_SOURCE = "okx-news" as const;
export const OKX_NEWS_PATH = "/api/v5/orbit/news-search";
const OKX_NEWS_POST_BASE = "https://www.okx.com/zh-hans/feed/post/";

const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 4000;
const MAX_AUTHOR_LENGTH = 120;
const MAX_EXTERNAL_ID_LENGTH = 128;
const MAX_ERROR_MSG_LENGTH = 120;
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

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
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

const LIST_KEYS = ["details", "list", "newsList", "articles"] as const;

function firstList(record: Record<string, unknown>): unknown[] | null {
  for (const key of LIST_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Finds the news array in the envelope. Known paths, first match wins: `data[0].details` (the live OKX shape, one page
 * per response); top-level `details` (legacy); `data` as an array of items; `data` as an object holding `details`,
 * `list`, `newsList` or `articles`. Returns null when none of them holds an array.
 */
function findNewsList(root: Record<string, unknown>): unknown[] | null {
  const data = root.data;
  if (Array.isArray(data) && data.length > 0) {
    const page = asRecord(data[0]);
    if (page !== null && Array.isArray(page.details)) return page.details;
  }

  if (Array.isArray(root.details)) return root.details;
  if (Array.isArray(data)) return data;

  const payload = asRecord(data);
  return payload === null ? null : firstList(payload);
}

/** Key names only, never values, so the message can be stored on source_health without leaking news content. */
function describeKeys(value: unknown): string {
  if (Array.isArray(value)) return "array";
  const record = asRecord(value);
  if (record === null) return value === null ? "null" : typeof value;
  const keys = Object.keys(record).slice(0, 20).map((key) => key.slice(0, 40));
  return keys.length === 0 ? "none" : keys.join(",");
}

function describeEnvelope(root: Record<string, unknown>): string {
  return `top-level keys: ${describeKeys(root)}; data keys: ${describeKeys(root.data)}`;
}

function toItem(raw: Record<string, unknown>, publishedMs: number): NewsItemInput | null {
  const rawId = pick(raw, "id", "newsId");
  const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
  if (id === "" || id.length > MAX_EXTERNAL_ID_LENGTH) return null;

  const importance = asText(raw.importance);
  if (importance !== null && importance.trim().toLowerCase() !== "high") return null;

  const body = firstNonEmpty(raw.content, raw.summary);
  if (body === "") return null;

  const title = firstNonEmpty(raw.title);
  const sourceUrl = (asText(pick(raw, "sourceUrl", "url")) ?? "").trim();

  return {
    source: OKX_NEWS_SOURCE,
    externalId: id,
    title: title === "" ? null : title.slice(0, MAX_TITLE_LENGTH),
    body: body.slice(0, MAX_BODY_LENGTH),
    url: isHttpUrl(sourceUrl) ? sourceUrl : `${OKX_NEWS_POST_BASE}${encodeURIComponent(id)}`,
    author: parseAuthors(pick(raw, "duplicateAuthors", "authors")),
    publishedAt: new Date(publishedMs).toISOString(),
    important: true,
  };
}

/**
 * Parses one news-search page. The envelope is OKX v5 `{ code: "0", msg, data: [{ details: [...], nextCursor }] }`,
 * and the items are `data[0].details`. The code must be "0"; a missing or other code throws with OKX's msg. Pagination
 * is driven by the caller through `end`, so nextCursor is not read. Entries without an id, content or a high
 * importance are skipped. An envelope with no recognised array throws NewsFormatError naming its keys, and so does a
 * non-empty page with nothing usable.
 */
export function parseOkxNewsPage(payload: unknown, nowMs: number = Date.now()): OkxNewsPage {
  const root = asRecord(payload);
  if (root === null) throw new NewsFormatError("okx-news response is not an object");

  if (root.code === undefined || root.code === null) throw new NewsFormatError("okx-news response has no code");
  const code = String(root.code);
  if (code !== "0") {
    const msg = (asText(root.msg) ?? "").trim().slice(0, MAX_ERROR_MSG_LENGTH);
    throw new NewsFormatError(`okx-news returned code ${code.slice(0, 20)}${msg === "" ? "" : `: ${msg}`}`);
  }

  const list = findNewsList(root);
  if (list === null) throw new NewsFormatError(`okx-news response has no news array (${describeEnvelope(root)})`);

  const items: NewsItemInput[] = [];
  let oldestMs: number | null = null;
  for (const entry of list) {
    const raw = asRecord(entry);
    if (raw === null) continue;
    const ms = parseCTime(pick(raw, "cTime", "createTime"));
    if (ms !== null && (oldestMs === null || ms < oldestMs)) oldestMs = ms;
    const item = toItem(raw, ms ?? nowMs);
    if (item !== null) items.push(item);
  }

  if (list.length > 0 && items.length === 0) {
    throw new NewsFormatError(`okx-news response contained no usable news items (first item keys: ${describeKeys(list[0])})`);
  }
  return { items, rawCount: list.length, oldestMs };
}
