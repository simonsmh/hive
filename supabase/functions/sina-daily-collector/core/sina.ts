// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import type { Candle } from "./types.ts";

/**
 * Sina Finance public daily K-line endpoint (quotes.sina.cn).
 * No API key. The request must carry `Referer: https://finance.sina.com.cn`,
 * otherwise Sina answers with a redirect script instead of data. The endpoint
 * returns JSONP: an optional `/* ... *\/` comment, then
 * `var _<code>=( [{day, open, high, low, close, volume}, ...] );`.
 * There is no turnover field in this endpoint, so volCcy is always 0.
 */
export const DEFAULT_SINA_BASE_URL = "https://quotes.sina.cn";
export const SINA_REFERER = "https://finance.sina.com.cn";
export const SINA_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * How many daily bars one fetch asks for. 120 covers MA50 (50 closes) plus the
 * ATR14 seed (15 bars) with roughly two months of buffer for suspensions and
 * holidays, while keeping one symbol's payload near 12 KB. The candles table
 * accumulates across runs, so this window does not cap long-term history:
 * every run upserts its window and older bars stay in the table.
 */
export const SINA_DATALEN = 120;

/** A-share market close in Asia/Shanghai. A bar dated today is confirmed only at or after this time. */
export const A_SHARE_CLOSE_MINUTES = 15 * 60;

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** ths_code as stored in symbol_map, for example 600487.SH, 001309.SZ, 000001.SH, 588170.SH. */
export const THS_CODE_PATTERN = /^([0-9]{6})\.(SH|SZ|BJ)$/;

export class SinaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SinaError";
  }
}

export class SinaRateLimitError extends SinaError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "SinaRateLimitError";
  }
}

export class SinaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinaParseError";
  }
}

export interface SinaDaily {
  /** Ascending by ts and unique by ts. The newest bar may still be forming (confirmed = false). */
  candles: Candle[];
  /** Bars that had a missing or inconsistent value. */
  rejected: number;
}

/**
 * Derives the Sina code from a symbol_map ths_code. SH/SZ/BJ map to the
 * lowercase Sina prefix; the six digits are unchanged, so stocks, indices and
 * ETFs all go through the same rule and no symbol is ever hard-coded.
 * Returns null for anything that does not fit the pattern (other suffixes and
 * malformed codes are skipped by the caller, never guessed).
 */
export function toSinaCode(thsCode: string | null): string | null {
  if (thsCode === null) return null;
  const match = THS_CODE_PATTERN.exec(thsCode);
  if (match === null) return null;
  return `${match[2]!.toLowerCase()}${match[1]!}`;
}

interface BeijingDate {
  /** Calendar date in Asia/Shanghai, YYYY-MM-DD. */
  date: string;
  /** Minutes since midnight in Asia/Shanghai. */
  minutes: number;
}

function beijingDate(nowMs: number): BeijingDate {
  const shifted = new Date(nowMs + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return {
    date: `${year}-${month}-${day}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * A bar's confirmed flag. Bars dated before today in Beijing are closed.
 * Today's bar is confirmed only once the A-share session has closed (15:00
 * Beijing); before that its close is still moving, so it must stay
 * unconfirmed or /api/atr (confirmed bars only) would ingest a live price.
 * A bar dated after today (clock skew or a bad feed) is never confirmed.
 */
export function barConfirmed(day: string, nowMs: number): boolean {
  const today = beijingDate(nowMs);
  if (day < today.date) return true;
  if (day > today.date) return false;
  return today.minutes >= A_SHARE_CLOSE_MINUTES;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finitePositive(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parses one Sina K-line JSONP body. Bars are keyed by 00:00 UTC of the
 * Beijing calendar date, the same convention Yahoo uses (00:00 UTC of the
 * exchange-local date), so date keys agree across sources. Unknown fields are
 * ignored; a row with a missing or inconsistent OHLC value is counted as
 * rejected instead of aborting the whole response.
 */
export function parseSinaKLine(body: string, options: { nowMs: number }): SinaDaily {
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) throw new SinaParseError("sina k-line response has no JSON array");
  let rows: unknown;
  try {
    rows = JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    throw new SinaParseError("sina k-line response is not valid JSON");
  }
  if (!Array.isArray(rows)) throw new SinaParseError("sina k-line response is not an array");

  const byTs = new Map<number, Candle>();
  let rejected = 0;
  for (const row of rows) {
    const record = asRecord(row);
    const day = record?.day;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      rejected += 1;
      continue;
    }
    const open = finitePositive(record?.open);
    const high = finitePositive(record?.high);
    const low = finitePositive(record?.low);
    const close = finitePositive(record?.close);
    const volume = finiteNonNegative(record?.volume);
    if (open === null || high === null || low === null || close === null || volume === null || high < low) {
      rejected += 1;
      continue;
    }
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    const ts = Date.UTC(year, month - 1, date);
    if (Number.isNaN(ts)) {
      rejected += 1;
      continue;
    }
    byTs.set(ts, {
      ts,
      open,
      high,
      low,
      close,
      volume,
      volCcy: 0,
      confirmed: barConfirmed(day, options.nowMs),
    });
  }
  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { candles, rejected };
}

export interface SinaMarketData {
  /** Daily bars for one Sina code, most recent window first in the request, ascending in the result. */
  getDaily(sinaCode: string): Promise<SinaDaily>;
}

export interface SinaClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between consecutive requests issued by this client. */
  minIntervalMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
  datalen?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(1_000 * 2 ** attempt, maxBackoffMs);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Public-only Sina K-line client. Retries 5xx and network errors with
 * exponential backoff, honours Retry-After, and treats 403 and 429 as rate
 * limiting (Sina answers without a Referer, or under load, with 403).
 * Sends no credentials; the Referer header is the only access requirement.
 */
export class SinaClient implements SinaMarketData {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private readonly datalen: number;
  private nextSlotAt = Number.NEGATIVE_INFINITY;

  constructor(options: SinaClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_SINA_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxBackoffMs = options.maxBackoffMs ?? 3_000;
    this.datalen = options.datalen ?? SINA_DATALEN;
  }

  async getDaily(sinaCode: string): Promise<SinaDaily> {
    const url = new URL("/cn/api/jsonp_v2.php/var%20_" + encodeURIComponent(sinaCode) + "=/CN_MarketDataService.getKLineData", this.baseUrl);
    url.searchParams.set("symbol", sinaCode);
    url.searchParams.set("scale", "240");
    url.searchParams.set("ma", "no");
    url.searchParams.set("datalen", String(this.datalen));
    const text = await this.request(url, sinaCode);
    return parseSinaKLine(text, { nowMs: this.now() });
  }

  /** Reserves the next request slot so concurrent callers stay at least minIntervalMs apart. */
  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private async request(url: URL, sinaCode: string): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pace();
      const isLast = attempt >= this.maxRetries;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: { accept: "*/*", referer: SINA_REFERER, "user-agent": SINA_USER_AGENT },
        });
      } catch (error) {
        if (isLast) throw new SinaError(`network error calling sina k-line ${sinaCode}: ${(error as Error).message}`);
        await this.sleep(retryDelayMs(attempt, this.maxBackoffMs));
        continue;
      }

      const rateLimited = response.status === 429 || response.status === 403;
      if (rateLimited || response.status >= 500) {
        if (isLast) {
          const message = `sina k-line ${sinaCode} returned HTTP ${response.status}`;
          throw rateLimited ? new SinaRateLimitError(message, response.status) : new SinaError(message, response.status);
        }
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        await this.sleep(Math.min(retryAfter ?? retryDelayMs(attempt, this.maxBackoffMs), this.maxBackoffMs));
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        throw new SinaError(`sina k-line ${sinaCode} returned HTTP ${response.status}`);
      }
      return text;
    }
  }
}
