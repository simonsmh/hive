import type { Candle } from "./types.js";

/**
 * Yahoo Finance public chart endpoint (v8). It needs neither an API key nor a crumb. The v7 quote endpoint does
 * need a crumb and a cookie, so the collector does not use it.
 */
export const DEFAULT_YAHOO_BASE_URL = "https://query1.finance.yahoo.com";
export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Symbols as stored in symbol_map.yahoo_symbol, for example NVDA, BZ=F, XAUUSD=X, BTC-USD, ^GSPC, BRK-B, 0700.HK. */
export const YAHOO_SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,24}$/;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BAR_MS = { "1m": MINUTE_MS, "1d": DAY_MS } as const;
const MAX_ERROR_DETAIL = 120;

export type YahooBarInterval = keyof typeof BAR_MS;

export class YahooError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "YahooError";
  }
}

export class YahooRateLimitError extends YahooError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "YahooRateLimitError";
  }
}

export class YahooParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooParseError";
  }
}

export interface YahooQuote {
  price: number;
  /** Epoch milliseconds of the bar the price was taken from. */
  ts: number;
}

export interface YahooChart {
  /** Ascending by ts and unique by ts. The newest bar may still be forming (confirmed = false). */
  candles: Candle[];
  /** Close of the newest 1m bar, stamped with its open time. Always null for daily responses. */
  quote: YahooQuote | null;
  /** Bars that had a missing or inconsistent value. Bars with no trades at all (every field null) are not counted. */
  rejected: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describeChartError(error: unknown): string | null {
  const record = asRecord(error);
  if (record === null) return null;
  const parts = [record.code, record.description].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length === 0 ? null : parts.join(": ").slice(0, MAX_ERROR_DETAIL);
}

/**
 * Daily bars open at the exchange's session time (13:30 UTC for NYSE). They are keyed by 00:00 UTC of the exchange-local
 * calendar date instead, the same convention as OKX 1Dutc, so weekday filters and date keys agree across sources.
 */
function barStartMs(seconds: number, interval: YahooBarInterval, gmtOffsetMs: number): number {
  const ms = seconds * 1000;
  if (interval === "1m") return ms;
  return Math.floor((ms + gmtOffsetMs) / DAY_MS) * DAY_MS;
}

/**
 * Parses a v8 chart response. Unknown symbols come back as HTTP 404 with chart.error set, and Yahoo can also return
 * 200 with chart.error, so both paths end in YahooError with a message that is safe to store on source_health.
 * A response with no timestamps (no data for the range) parses to no candles and no quote, which is not an error.
 */
export function parseYahooChart(payload: unknown, options: { interval: YahooBarInterval; nowMs: number }): YahooChart {
  const chart = asRecord(asRecord(payload)?.chart);
  if (chart === null) throw new YahooParseError("yahoo chart response has no chart object");
  const chartError = describeChartError(chart.error);
  if (chartError !== null) throw new YahooError(`yahoo chart error ${chartError}`);

  const result = Array.isArray(chart.result) ? asRecord(chart.result[0]) : null;
  if (result === null) throw new YahooParseError("yahoo chart response has no result");

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  if (timestamps.length === 0) return { candles: [], quote: null, rejected: 0 };

  const gmtOffsetMs = (finiteOrNull(asRecord(result.meta)?.gmtoffset) ?? 0) * 1000;
  const indicators = asRecord(result.indicators);
  const block = Array.isArray(indicators?.quote) ? asRecord(indicators.quote[0]) : null;
  if (block === null) throw new YahooParseError("yahoo chart response has timestamps but no quote block");

  const column = (name: string): unknown[] => {
    const values = block[name];
    if (!Array.isArray(values) || values.length !== timestamps.length) {
      throw new YahooParseError(`yahoo chart ${name} does not match the timestamp count`);
    }
    return values;
  };
  const opens = column("open");
  const highs = column("high");
  const lows = column("low");
  const closes = column("close");
  const volumes = Array.isArray(block.volume) && block.volume.length === timestamps.length ? block.volume : null;

  const byStart = new Map<number, Candle>();
  let rejected = 0;
  for (let i = 0; i < timestamps.length; i += 1) {
    const seconds = finiteOrNull(timestamps[i]);
    const open = finiteOrNull(opens[i]);
    const high = finiteOrNull(highs[i]);
    const low = finiteOrNull(lows[i]);
    const close = finiteOrNull(closes[i]);
    if (open === null && high === null && low === null && close === null) continue;
    if (
      seconds === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      open <= 0 ||
      low <= 0 ||
      high < low ||
      close <= 0
    ) {
      rejected += 1;
      continue;
    }
    const ts = barStartMs(seconds, options.interval, gmtOffsetMs);
    byStart.set(ts, {
      ts,
      open,
      high,
      low,
      close,
      volume: Math.max(0, finiteOrNull(volumes?.[i]) ?? 0),
      volCcy: 0,
      confirmed: ts + BAR_MS[options.interval] <= options.nowMs,
    });
  }

  const candles = [...byStart.values()].sort((a, b) => a.ts - b.ts);
  const newest = candles[candles.length - 1];
  const quote = options.interval === "1m" && newest ? { price: newest.close, ts: newest.ts } : null;
  return { candles, quote, rejected };
}

export interface YahooMarketData {
  /** Last session at 1-minute resolution, including pre- and post-market. */
  getIntraday(symbol: string): Promise<YahooChart>;
  /** Roughly the last quarter at daily resolution. */
  getDaily(symbol: string): Promise<YahooChart>;
}

export interface YahooClientOptions {
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between consecutive requests issued by this client. */
  minIntervalMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
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

/** Reads the chart.error detail from a non-2xx body, if there is one. Never returns the raw body. */
function errorDetail(text: string): string {
  try {
    return describeChartError(asRecord(asRecord(JSON.parse(text))?.chart)?.error) ?? "";
  } catch {
    return "";
  }
}

/**
 * Public-only Yahoo chart client. Retries 5xx and network errors with exponential backoff, honours Retry-After, and
 * treats 403 and 429 as rate limiting (Yahoo throttles by address and does not say when the block ends). Sends no
 * credentials and no cookies.
 */
export class YahooClient implements YahooMarketData {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private nextSlotAt = Number.NEGATIVE_INFINITY;

  constructor(options: YahooClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_YAHOO_BASE_URL;
    this.userAgent = options.userAgent ?? YAHOO_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxBackoffMs = options.maxBackoffMs ?? 3_000;
  }

  getIntraday(symbol: string): Promise<YahooChart> {
    return this.chart(symbol, { interval: "1m", range: "1d", includePrePost: "true" }, "1m");
  }

  getDaily(symbol: string): Promise<YahooChart> {
    return this.chart(symbol, { interval: "1d", range: "3mo" }, "1d");
  }

  private async chart(symbol: string, params: Record<string, string>, interval: YahooBarInterval): Promise<YahooChart> {
    if (!YAHOO_SYMBOL_PATTERN.test(symbol)) throw new YahooError(`invalid yahoo symbol "${symbol.slice(0, 24)}"`);
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(symbol)}`, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const payload = await this.request(url, symbol);
    return parseYahooChart(payload, { interval, nowMs: this.now() });
  }

  /** Reserves the next request slot so concurrent callers stay at least minIntervalMs apart. */
  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private async request(url: URL, symbol: string): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pace();
      const isLast = attempt >= this.maxRetries;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": this.userAgent },
        });
      } catch (error) {
        if (isLast) throw new YahooError(`network error calling yahoo chart ${symbol}: ${(error as Error).message}`);
        await this.sleep(retryDelayMs(attempt, this.maxBackoffMs));
        continue;
      }

      const rateLimited = response.status === 429 || response.status === 403;
      if (rateLimited || response.status >= 500) {
        if (isLast) {
          const message = `yahoo chart ${symbol} returned HTTP ${response.status}`;
          throw rateLimited ? new YahooRateLimitError(message, response.status) : new YahooError(message, response.status);
        }
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        await this.sleep(Math.min(retryAfter ?? retryDelayMs(attempt, this.maxBackoffMs), this.maxBackoffMs));
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        const detail = errorDetail(text);
        const message = `yahoo chart ${symbol} returned HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`;
        throw new YahooError(message, response.status);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new YahooParseError(`yahoo chart ${symbol} response is not JSON`);
      }
    }
  }
}
