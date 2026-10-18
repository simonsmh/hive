/** Jin10 flash newsfeed, normalised into rows for the hive_news_ingest RPC. Pure: no I/O. */

export const NEWS_SOURCES = ["jin10", "okx-news", "blockbeats"] as const;
export type NewsSource = (typeof NEWS_SOURCES)[number];

/** Jin10 publishes flash timestamps in Beijing time (UTC+8) without a zone designator. */
const BEIJING_OFFSET = "+08:00";
const JIN10_FLASH_BASE = "https://flash.jin10.com/detail/";
const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 4000;
const MAX_EXTERNAL_ID_LENGTH = 128;

export class NewsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewsFormatError";
  }
}

export interface NewsItemInput {
  source: NewsSource;
  externalId: string;
  title: string | null;
  body: string;
  url: string;
  author: string | null;
  publishedAt: string;
  /** Jin10 marks market-moving flashes as important; stored as a 0/1 score. */
  important: boolean;
}

/** Shape consumed by public.hive_news_ingest (snake_case, see migration 20261013000012). */
export interface NewsIngestRow {
  external_id: string;
  title: string | null;
  body: string;
  url: string;
  author: string | null;
  published_at: string;
  score: number;
}

export function stripMarkup(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Accepts "YYYY-MM-DD HH:mm:ss" (Beijing time) or any ISO-8601 string with a zone. Returns null when unparseable. */
export function parseJin10Time(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(value);
  const ms = local ? Date.parse(`${local[1]}T${local[2]}${local[2]!.length === 5 ? ":00" : ""}${BEIJING_OFFSET}`) : Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

/**
 * Parses a `get_flash_list` response. The endpoint is unofficial, so every field is treated as optional
 * except the item id and the content. Items without content are skipped. If the envelope is not recognised
 * or every item is unusable, this throws NewsFormatError so the caller can mark the source degraded.
 */
export function parseJin10FlashList(payload: unknown, nowMs: number = Date.now()): NewsItemInput[] {
  const root = asRecord(payload);
  const envelopeStatus = root?.status ?? root?.code;
  if (typeof envelopeStatus === "number" && envelopeStatus !== 200 && envelopeStatus !== 0) {
    throw new NewsFormatError(`jin10 returned status ${envelopeStatus}`);
  }

  const list = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? (root?.data as unknown[]) : null;
  if (list === null) throw new NewsFormatError("jin10 response has no data array");

  const items: NewsItemInput[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id).trim() : "";
    const data = asRecord(item.data);
    const contentRaw = asText(data?.content) ?? asText(item.content);
    const content = contentRaw === null ? "" : stripMarkup(contentRaw);
    if (id === "" || id.length > MAX_EXTERNAL_ID_LENGTH || content === "") continue;

    const titleRaw = asText(data?.title) ?? asText(item.title);
    const title = titleRaw === null ? "" : stripMarkup(titleRaw);
    const linkRaw = asText(data?.link) ?? asText(item.link) ?? "";
    const url = isHttpUrl(linkRaw) ? linkRaw : `${JIN10_FLASH_BASE}${encodeURIComponent(id)}`;
    const author = asText(data?.source)?.trim() || null;

    items.push({
      source: "jin10",
      externalId: id,
      title: title === "" ? null : title.slice(0, MAX_TITLE_LENGTH),
      body: content.slice(0, MAX_BODY_LENGTH),
      url,
      author: author === null ? null : author.slice(0, 120),
      publishedAt: parseJin10Time(item.time) ?? new Date(nowMs).toISOString(),
      important: item.important === 1 || item.important === true,
    });
  }

  if (list.length > 0 && items.length === 0) {
    throw new NewsFormatError("jin10 response contained no usable flash items");
  }
  return items;
}

const BLOCKBEATS_FLASH_BASE = "https://www.theblockbeats.info/flash/";

/**
 * Parses a decrypted BlockBeats `/v2/newsflash/list` payload ({ page, limit, list }). The transport is
 * unofficial, so every field is treated as optional except the item id and the content. Items without
 * content are skipped. If the envelope is not recognised or every item is unusable, this throws
 * NewsFormatError so the caller can mark the source degraded.
 */
export function parseBlockBeatsFlashList(payload: unknown, nowMs: number = Date.now()): NewsItemInput[] {
  const root = asRecord(payload);
  const envelopeCode = root?.code;
  if (typeof envelopeCode === "number" && envelopeCode !== 0) {
    throw new NewsFormatError(`blockbeats returned code ${envelopeCode}`);
  }

  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.list)
      ? (root.list as unknown[])
      : Array.isArray(root?.data)
        ? (root.data as unknown[])
        : Array.isArray(asRecord(root?.data)?.list)
          ? (asRecord(root?.data)!.list as unknown[])
          : null;
  if (list === null) throw new NewsFormatError("blockbeats response has no list array");

  const items: NewsItemInput[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id).trim() : "";
    const contentRaw = asText(item.content);
    const content = contentRaw === null ? "" : stripMarkup(contentRaw);
    if (id === "" || id.length > MAX_EXTERNAL_ID_LENGTH || content === "") continue;

    const titleRaw = asText(item.title);
    const title = titleRaw === null ? "" : stripMarkup(titleRaw);
    const linkRaw = asText(item.url) ?? "";
    const url = isHttpUrl(linkRaw) ? linkRaw : `${BLOCKBEATS_FLASH_BASE}${encodeURIComponent(id)}`;
    const addTimeSec = typeof item.add_time === "number" ? item.add_time : Number(item.add_time);
    const publishedAt =
      Number.isFinite(addTimeSec) && addTimeSec > 0 ? new Date(addTimeSec * 1000).toISOString() : new Date(nowMs).toISOString();

    items.push({
      source: "blockbeats",
      externalId: id,
      title: title === "" ? null : title.slice(0, MAX_TITLE_LENGTH),
      body: content.slice(0, MAX_BODY_LENGTH),
      url,
      author: null,
      publishedAt,
      important: item.is_hot === 1 || item.is_hot === true || item.is_top === 1 || item.is_top === true,
    });
  }

  if (list.length > 0 && items.length === 0) {
    throw new NewsFormatError("blockbeats response contained no usable flash items");
  }
  return items;
}

export function toIngestRows(items: readonly NewsItemInput[]): NewsIngestRow[] {
  return items.map((item) => ({
    external_id: item.externalId,
    title: item.title,
    body: item.body,
    url: item.url,
    author: item.author,
    published_at: item.publishedAt,
    score: item.important ? 1 : 0,
  }));
}
