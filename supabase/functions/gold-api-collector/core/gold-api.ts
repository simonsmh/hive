/**
 * Official Gold API (https://gold-api.com/docs, https://gold-api.com/llms.txt)
 * live spot quote. GET /price/XAU returns the USD gold spot price per troy
 * ounce. History and OHLC endpoints require an API key and are not used here.
 */
export const GOLD_API_BASE_URL = "https://api.gold-api.com";
/** Documented live spot path; omitting the currency defaults to USD. */
export const GOLD_API_SPOT_PATH = "/price/XAU";
/** Hive symbol, kept distinct from the OKX perpetual row `XAU`. */
export const GOLD_API_HIVE_SYMBOL = "XAUUSD";
export const GOLD_API_HIVE_SOURCE = "gold-api";
/** Default freshness window for a snapshot (collector is every 2 minutes). */
export const DEFAULT_MAX_QUOTE_AGE_MS = 8 * 60_000;

export class GoldApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldApiError";
  }
}

export interface GoldApiSpotQuote {
  price: number;
  /** `updatedAt` from the API, as epoch milliseconds. */
  ts: number;
  currency: "USD";
  symbol: "XAU";
  name: string;
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new GoldApiError("gold-api payload must be an object");
  }
  return raw as Record<string, unknown>;
}

/**
 * Parses a documented `/price/XAU` (USD) body. Rejects non-USD quotes, missing
 * timestamps, and prices whose `updatedAt` is older than `maxAgeMs`.
 * `updatedAt` is the time Gold API last fetched the price from its source.
 */
export function parseGoldApiSpotUsd(
  payload: unknown,
  options: { nowMs: number; maxAgeMs?: number } = { nowMs: Date.now() },
): GoldApiSpotQuote {
  const obj = requireObject(payload);
  if (obj.symbol !== "XAU") throw new GoldApiError("gold-api symbol must be XAU");
  if (obj.currency !== "USD") throw new GoldApiError("gold-api currency must be USD");
  const price = obj.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new GoldApiError("gold-api price must be a finite number greater than 0");
  }
  const updatedAt = obj.updatedAt;
  if (typeof updatedAt !== "string" || updatedAt.trim() === "") {
    throw new GoldApiError("gold-api updatedAt must be an ISO-8601 UTC timestamp");
  }
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) throw new GoldApiError("gold-api updatedAt is not a valid timestamp");
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  if (options.nowMs - ts > maxAgeMs) {
    throw new GoldApiError(`gold-api quote is stale: updatedAt ${updatedAt}`);
  }
  if (ts - options.nowMs > 120_000) {
    throw new GoldApiError(`gold-api updatedAt is too far in the future: ${updatedAt}`);
  }
  const name = typeof obj.name === "string" && obj.name.trim() !== "" ? obj.name.trim() : "Gold";
  return { price, ts, currency: "USD", symbol: "XAU", name };
}
