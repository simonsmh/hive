// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import type { Candle } from "./types.ts";

export const DEFAULT_OKX_BASE_URL = "https://www.okx.com";

export class OkxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OkxError";
  }
}

export class OkxRateLimitError extends OkxError {
  constructor(message: string, status?: number, code?: string) {
    super(message, status, code);
    this.name = "OkxRateLimitError";
  }
}

export class OkxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkxParseError";
  }
}

export interface OkxInstrument {
  instId: string;
  instType: string;
  state: string;
}

export interface OkxTicker {
  instId: string;
  last: number;
  ts: number;
}

/** One row of the bulk tickers feed, with the 24h volume fields the universe ranking needs. */
export interface OkxSwapTicker {
  instId: string;
  last: number;
  /** 24h volume in the base currency (for BTC-USDT-SWAP this is BTC, not USDT). */
  volCcy24h: number;
  /** 24h change ratio derived from open24h, null when OKX reports no open price. */
  change24h: number | null;
  ts: number;
}

function toFiniteNumber(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    throw new OkxParseError(`field ${field} is not a finite number: ${String(value)}`);
  }
  return n;
}

/**
 * OKX candle row: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
 * confirm is "1" once the bar is closed, "0" while it is still forming.
 */
export function parseOkxCandleRow(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 9) {
    throw new OkxParseError("candle row must be an array of at least 9 fields");
  }
  const candle: Candle = {
    ts: toFiniteNumber(row[0], "ts"),
    open: toFiniteNumber(row[1], "open"),
    high: toFiniteNumber(row[2], "high"),
    low: toFiniteNumber(row[3], "low"),
    close: toFiniteNumber(row[4], "close"),
    volume: toFiniteNumber(row[5], "volume"),
    volCcy: toFiniteNumber(row[6], "volCcy"),
    confirmed: row[8] === "1",
  };
  if (candle.high < candle.low) {
    throw new OkxParseError(`high ${candle.high} is below low ${candle.low} at ts ${candle.ts}`);
  }
  return candle;
}

export interface ParsedCandles {
  /** Ascending by ts. */
  candles: Candle[];
  rejected: number;
}

/** Parses a candles response; invalid rows are counted and skipped rather than failing the batch. */
export function parseOkxCandles(data: unknown): ParsedCandles {
  if (!Array.isArray(data)) {
    throw new OkxParseError("candles data must be an array");
  }
  const candles: Candle[] = [];
  let rejected = 0;
  for (const row of data) {
    try {
      candles.push(parseOkxCandleRow(row));
    } catch {
      rejected += 1;
    }
  }
  candles.sort((a, b) => a.ts - b.ts);
  return { candles, rejected };
}

export function parseOkxTicker(data: unknown): OkxTicker {
  if (!Array.isArray(data) || data.length === 0) {
    throw new OkxParseError("ticker data is empty");
  }
  const item = data[0] as Record<string, unknown>;
  if (typeof item.instId !== "string") {
    throw new OkxParseError("ticker instId missing");
  }
  return {
    instId: item.instId,
    last: toFiniteNumber(item.last, "last"),
    ts: toFiniteNumber(item.ts, "ts"),
  };
}

export function parseOkxSwapTickers(data: unknown): OkxSwapTicker[] {
  if (!Array.isArray(data)) {
    throw new OkxParseError("tickers data must be an array");
  }
  const tickers: OkxSwapTicker[] = [];
  for (const raw of data) {
    const item = raw as Record<string, unknown>;
    if (typeof item.instId !== "string" || !item.instId.endsWith("-SWAP")) continue;
    const last = typeof item.last === "string" && item.last.trim() !== "" ? Number(item.last) : NaN;
    const volCcy24h = typeof item.volCcy24h === "string" && item.volCcy24h.trim() !== "" ? Number(item.volCcy24h) : NaN;
    if (!Number.isFinite(last) || last <= 0 || !Number.isFinite(volCcy24h) || volCcy24h < 0) continue;
    const open24h = typeof item.open24h === "string" && item.open24h.trim() !== "" ? Number(item.open24h) : NaN;
    tickers.push({
      instId: item.instId,
      last,
      volCcy24h,
      change24h: Number.isFinite(open24h) && open24h > 0 ? last / open24h - 1 : null,
      ts: typeof item.ts === "string" && item.ts.trim() !== "" ? Number(item.ts) : 0,
    });
  }
  return tickers;
}

export function parseOkxInstruments(data: unknown): OkxInstrument[] {
  if (!Array.isArray(data)) {
    throw new OkxParseError("instruments data must be an array");
  }
  return data.map((raw) => {
    const item = raw as Record<string, unknown>;
    if (typeof item.instId !== "string" || typeof item.instType !== "string" || typeof item.state !== "string") {
      throw new OkxParseError("instrument entry missing instId/instType/state");
    }
    return { instId: item.instId, instType: item.instType, state: item.state };
  });
}

export interface OkxClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between consecutive requests issued by this client. */
  minIntervalMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
}

const RATE_LIMIT_CODE = "50011";

export function backoffDelayMs(attempt: number, maxBackoffMs = 60_000): number {
  return Math.min(1_000 * 2 ** attempt, maxBackoffMs);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Public-only OKX market data client. Retries with exponential backoff on
 * 403/429/5xx/network errors (honouring Retry-After) and never sends credentials.
 */
export class OkxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private nextSlotAt = Number.NEGATIVE_INFINITY;

  constructor(options: OkxClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_OKX_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.maxRetries = options.maxRetries ?? 4;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  async getInstruments(instType = "SWAP"): Promise<OkxInstrument[]> {
    return parseOkxInstruments(await this.request("/api/v5/public/instruments", { instType }));
  }

  /** Every live SWAP ticker in one call; the feed behind the universe ranking. */
  async getSwapTickers(): Promise<OkxSwapTicker[]> {
    return parseOkxSwapTickers(await this.request("/api/v5/market/tickers", { instType: "SWAP" }));
  }

  async getTicker(instId: string): Promise<OkxTicker> {
    return parseOkxTicker(await this.request("/api/v5/market/ticker", { instId }));
  }

  async getCandles(instId: string, bar: string, limit: number): Promise<ParsedCandles> {
    return parseOkxCandles(await this.request("/api/v5/market/candles", { instId, bar, limit: String(limit) }));
  }

  /** Reserves the next request slot, so concurrent callers stay spaced by minIntervalMs. */
  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    for (let attempt = 0; ; attempt += 1) {
      await this.pace();
      const isLast = attempt >= this.maxRetries;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      } catch (error) {
        if (isLast) throw new OkxError(`network error calling ${path}: ${(error as Error).message}`);
        await this.sleep(backoffDelayMs(attempt, this.maxBackoffMs));
        continue;
      }

      const retryable = response.status === 403 || response.status === 429 || response.status >= 500;
      if (retryable) {
        const rateLimited = response.status === 403 || response.status === 429;
        if (isLast) {
          const message = `OKX ${path} returned HTTP ${response.status}`;
          throw rateLimited
            ? new OkxRateLimitError(message, response.status)
            : new OkxError(message, response.status);
        }
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        await this.sleep(retryAfter ?? backoffDelayMs(attempt, this.maxBackoffMs));
        continue;
      }

      if (!response.ok) {
        throw new OkxError(`OKX ${path} returned HTTP ${response.status}`, response.status);
      }

      const body = (await response.json()) as { code?: string; msg?: string; data?: unknown };
      if (body.code === RATE_LIMIT_CODE) {
        if (isLast) throw new OkxRateLimitError(`OKX ${path} rate limited`, response.status, body.code);
        await this.sleep(backoffDelayMs(attempt, this.maxBackoffMs));
        continue;
      }
      if (body.code !== "0") {
        throw new OkxError(`OKX ${path} error ${body.code}: ${body.msg ?? "unknown"}`, response.status, body.code);
      }
      return body.data;
    }
  }
}
