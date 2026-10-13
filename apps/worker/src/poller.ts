import { OkxRateLimitError, type Interval, type OkxTicker, type ParsedCandles } from "@hive/core";
import type { Store } from "./store.js";

export interface MarketDataSource {
  getTicker(instId: string): Promise<OkxTicker>;
  getCandles(instId: string, bar: string, limit: number): Promise<ParsedCandles>;
}

export interface PollTarget {
  symbol: string;
  instId: string;
}

export interface CandleRequest {
  /** Interval stored in candles.interval. */
  interval: Interval;
  /** OKX bar name. */
  bar: string;
  limit: number;
}

/**
 * Daily bars use OKX `1Dutc` (00:00 UTC). Plain `1D` opens at 16:00 UTC (UTC+8),
 * which would shift bar dates and break the UTC weekday filter used for XAU ATR.
 */
export const DEFAULT_CANDLE_REQUESTS: readonly CandleRequest[] = [
  { interval: "1m", bar: "1m", limit: 60 },
  { interval: "5m", bar: "5m", limit: 60 },
  { interval: "15m", bar: "15m", limit: 60 },
  { interval: "1D", bar: "1Dutc", limit: 60 },
];

export interface CycleOptions {
  client: MarketDataSource;
  store: Store;
  targets: readonly PollTarget[];
  candleRequests?: readonly CandleRequest[];
  log: (message: string) => void;
}

export interface CycleResult {
  /** OKX requests that returned data. */
  successes: number;
  /** OKX requests that failed after client-side retries. */
  failures: number;
  /** Database writes that failed. The cycle continues past each one. */
  writeErrors: number;
  rateLimited: boolean;
}

/**
 * One poll pass over every target. OKX request failures and database write failures
 * are each logged and counted individually, so one bad request or write does not stop
 * the rest of the cycle. source_health for `okx` is updated once per cycle: success if
 * at least one row was persisted, failure if none was and something went wrong.
 */
export async function runPollCycle(options: CycleOptions): Promise<CycleResult> {
  const { client, store, targets, log } = options;
  const candleRequests = options.candleRequests ?? DEFAULT_CANDLE_REQUESTS;
  let successes = 0;
  let failures = 0;
  let writeErrors = 0;
  let persisted = 0;
  let rateLimited = false;
  let lastError = "";

  const fetchFromOkx = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await fn();
      successes += 1;
      return result;
    } catch (error) {
      failures += 1;
      if (error instanceof OkxRateLimitError) rateLimited = true;
      lastError = `${label}: ${(error as Error).message}`;
      log(`okx request failed (${label}): ${(error as Error).message}`);
      return null;
    }
  };

  const persist = async (label: string, write: () => Promise<unknown>): Promise<void> => {
    try {
      await write();
      persisted += 1;
    } catch (error) {
      writeErrors += 1;
      lastError = `${label}: ${(error as Error).message}`;
      log(`database write failed (${label}): ${(error as Error).message}`);
    }
  };

  for (const target of targets) {
    const ticker = await fetchFromOkx(`ticker ${target.instId}`, () => client.getTicker(target.instId));
    if (ticker) {
      await persist(`quote ${target.symbol}`, () =>
        store.upsertQuote(target.symbol, "okx", { symbol: target.symbol, price: ticker.last, ts: ticker.ts }),
      );
    }

    for (const request of candleRequests) {
      const parsed = await fetchFromOkx(`candles ${request.interval} ${target.instId}`, () =>
        client.getCandles(target.instId, request.bar, request.limit),
      );
      if (!parsed) continue;
      if (parsed.rejected > 0) {
        log(`rejected ${parsed.rejected} malformed candle rows for ${target.instId} ${request.interval}`);
      }
      if (parsed.candles.length === 0) continue;
      await persist(`candles ${request.interval} ${target.symbol}`, () =>
        store.upsertCandles(target.symbol, "okx", request.interval, parsed.candles),
      );
    }
  }

  if (persisted > 0) {
    await store.recordSourceSuccess("okx");
  } else if (failures > 0 || writeErrors > 0) {
    await store.recordSourceFailure("okx", lastError);
  }

  return { successes, failures, writeErrors, rateLimited };
}
