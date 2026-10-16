import { beijingDate } from "./ths-plan.js";

export const DEFAULT_THS_BASE_URL = "https://fuyao.aicubes.cn";
/** Snapshot endpoints take a comma-separated thscodes list. Stock sends at most this many per request. */
export const THS_BATCH_SIZE = 100;
export const THS_MARKET_PAGE_SIZE = 100;

export type ThsErrorKind =
  | "rate_limited"
  | "auth"
  | "not_ready"
  | "invalid_request"
  | "not_found"
  | "unsupported"
  | "server"
  | "network"
  | "malformed"
  | "upstream";

const RETRYABLE_KINDS: ReadonlySet<ThsErrorKind> = new Set(["rate_limited", "server", "network"]);

export class ThsError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly kind: ThsErrorKind,
    readonly code: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ThsError";
    this.retryable = RETRYABLE_KINDS.has(kind);
  }
}

export function errorKindForCode(code: number): ThsErrorKind {
  switch (code) {
    case 1001:
    case 1002:
    case 1003:
    case 1004:
      return "invalid_request";
    case 2001:
    case 2003:
      return "auth";
    case 3001:
      return "not_found";
    case 3002:
      return "not_ready";
    case 3004:
      return "unsupported";
    case 4001:
      return "rate_limited";
    case 5001:
    case 5002:
    case 5003:
      return "server";
    default:
      return "upstream";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Checks `code` before anything else, because HTTP 200 does not mean success. */
export function unwrapEnvelope(body: unknown): { requestId: string | null; data: unknown } {
  if (!isRecord(body) || typeof body.code !== "number") {
    throw new ThsError("response is not a THS envelope", "malformed");
  }
  const requestId = typeof body.request_id === "string" ? body.request_id : null;
  if (body.code !== 0) {
    const message = typeof body.message === "string" ? body.message.slice(0, 200) : "no message";
    throw new ThsError(`THS API code ${body.code}: ${message}`, errorKindForCode(body.code), body.code, requestId);
  }
  return { requestId, data: body.data ?? null };
}

export function itemsOf(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data) || !Array.isArray(data.item)) {
    throw new ThsError("response data has no item array", "malformed");
  }
  return data.item.filter(isRecord);
}

export interface ThsSnapshot {
  /** Epoch milliseconds of the newest valid upstream data, or null when nothing valid was returned. */
  timestamp: number | null;
  total: number | null;
  items: Record<string, unknown>[];
}

export function parseSnapshot(data: unknown): ThsSnapshot {
  if (!isRecord(data)) throw new ThsError("snapshot data is not an object", "malformed");
  return {
    timestamp: finiteOrNull(data.timestamp),
    total: finiteOrNull(data.total),
    items: itemsOf(data),
  };
}

export interface ThsQuote {
  thscode: string;
  lastPrice: number;
}

/** Field names come from the verified snapshot shape (thscode, last_price). Invalid rows return null. */
export function quoteOf(item: Record<string, unknown>): ThsQuote | null {
  const thscode = typeof item.thscode === "string" ? item.thscode.trim().toUpperCase() : "";
  const price = typeof item.last_price === "number" ? item.last_price : Number.NaN;
  if (thscode === "" || !Number.isFinite(price) || price <= 0) return null;
  return { thscode, lastPrice: price };
}

export type ThsDirection = "up" | "down" | "flat" | "unknown";

/** Direction from price_change_ratio_pct, the verified percent field. */
export function directionOf(item: Record<string, unknown>): ThsDirection {
  const ratio = item.price_change_ratio_pct;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "unknown";
  if (ratio > 0) return "up";
  if (ratio < 0) return "down";
  return "flat";
}

const THS_CODE_PATTERN = /^\d{6}\.(SH|SZ|BJ|TI)$/;

export function isThsCode(value: string): boolean {
  return THS_CODE_PATTERN.test(value);
}

function dayFromString(value: string): string | null {
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null;
}

function calendarDay(row: unknown): string | null {
  if (typeof row === "string") return dayFromString(row);
  if (typeof row === "number") return Number.isFinite(row) ? beijingDate(row) : null;
  if (!isRecord(row)) return null;
  for (const key of ["date", "trade_date", "trading_day"]) {
    const value = row[key];
    if (typeof value === "string") {
      const day = dayFromString(value);
      if (day) return day;
    }
  }
  for (const key of ["date_ms", "timestamp", "ts"]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return beijingDate(value);
  }
  return null;
}

/**
 * Trading days as YYYY-MM-DD. The calendar item shape is not verified against a live response, so the parser
 * accepts strings, millisecond timestamps and objects with a date-like key. If nothing parses, it throws instead of
 * returning an empty set, so the caller falls back to weekday-only scheduling.
 */
export function parseTradingDays(data: unknown): Set<string> {
  const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.item) ? data.item : null;
  if (!rows) throw new ThsError("calendar data has no item list", "malformed");
  const days = new Set<string>();
  for (const row of rows) {
    const day = calendarDay(row);
    if (day) days.add(day);
  }
  if (days.size === 0) throw new ThsError("calendar has no parseable trading days", "malformed");
  return days;
}

export interface ThsMarketData {
  indexSnapshot(thscodes: readonly string[]): Promise<ThsSnapshot>;
  stockSnapshot(thscodes: readonly string[]): Promise<ThsSnapshot>;
  marketSnapshotPage(offset: number, limit: number): Promise<ThsSnapshot>;
  auctionSnapshot(thscodes: readonly string[], stage: "live" | "final"): Promise<unknown>;
  auctionBenchmark(): Promise<unknown>;
  limitPool(name: "limit-up-pool" | "limit-down-pool" | "limit-break-pool", page: number, size: number): Promise<unknown>;
  limitUpLadder(): Promise<unknown>;
  hotStock(period: "day" | "hour"): Promise<unknown>;
  skyrocket(period: "day" | "hour"): Promise<unknown>;
  anomalyList(): Promise<unknown>;
  dragonTiger(): Promise<unknown>;
  tradingDays(): Promise<Set<string>>;
}

export interface ThsClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for rate limits, 5xx and network errors. */
  maxRetries?: number;
  maxBackoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Public REST client for the HiThink data API. Sends the key only in the X-api-key header and never includes it in
 * an error message. Retries 4001, 5xx and network errors with exponential backoff, up to maxRetries times.
 */
export class ThsClient implements ThsMarketData {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;

  constructor(options: ThsClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_THS_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxBackoffMs = options.maxBackoffMs ?? 8_000;
  }

  indexSnapshot(thscodes: readonly string[]): Promise<ThsSnapshot> {
    return this.snapshot("/api/a-share-index/prices/snapshot", { thscodes: thscodes.join(",") });
  }

  stockSnapshot(thscodes: readonly string[]): Promise<ThsSnapshot> {
    return this.snapshot("/api/a-share/prices/snapshot", { thscodes: thscodes.join(",") });
  }

  marketSnapshotPage(offset: number, limit: number): Promise<ThsSnapshot> {
    return this.snapshot("/api/a-share/prices/snapshot", { limit, offset });
  }

  auctionSnapshot(thscodes: readonly string[], stage: "live" | "final"): Promise<unknown> {
    return this.get("/api/a-share/auction/snapshot", { thscodes: thscodes.join(","), stage });
  }

  auctionBenchmark(): Promise<unknown> {
    return this.get("/api/a-share/auction/short-term-benchmark");
  }

  limitPool(name: "limit-up-pool" | "limit-down-pool" | "limit-break-pool", page: number, size: number): Promise<unknown> {
    return this.get(`/api/a-share/special-data/${name}`, { page, size });
  }

  limitUpLadder(): Promise<unknown> {
    return this.get("/api/a-share/special-data/limit-up-ladder");
  }

  hotStock(period: "day" | "hour"): Promise<unknown> {
    return this.get("/api/a-share/special-data/hot-stock-list", { period });
  }

  skyrocket(period: "day" | "hour"): Promise<unknown> {
    return this.get("/api/a-share/special-data/skyrocket-list", { period });
  }

  anomalyList(): Promise<unknown> {
    return this.get("/api/a-share/special-data/anomaly-analysis-list");
  }

  dragonTiger(): Promise<unknown> {
    return this.get("/api/a-share/special-data/dragon-tiger-list");
  }

  async tradingDays(): Promise<Set<string>> {
    return parseTradingDays(await this.get("/api/a-share/calendar/trading-days"));
  }

  private async snapshot(path: string, params: Record<string, string | number>): Promise<ThsSnapshot> {
    return parseSnapshot(await this.get(path, params));
  }

  private async get(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.attempt(url, path);
      } catch (error) {
        if (!(error instanceof ThsError) || !error.retryable || attempt >= this.maxRetries) throw error;
        await this.sleep(Math.min(1000 * 2 ** attempt, this.maxBackoffMs));
      }
    }
  }

  private async attempt(url: URL, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json", "x-api-key": this.apiKey } });
    } catch (cause) {
      throw new ThsError(`network error calling ${path}: ${(cause as Error).message}`, "network");
    }
    if (response.status === 429) throw new ThsError(`${path} returned HTTP 429`, "rate_limited");
    if (response.status === 401 || response.status === 403) {
      throw new ThsError(`${path} returned HTTP ${response.status}`, "auth");
    }
    if (response.status >= 500) throw new ThsError(`${path} returned HTTP ${response.status}`, "server");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ThsError(`${path} returned a non-JSON body (HTTP ${response.status})`, "malformed");
    }
    const { data } = unwrapEnvelope(body);
    if (!response.ok) throw new ThsError(`${path} returned HTTP ${response.status}`, "upstream");
    return data;
  }
}
