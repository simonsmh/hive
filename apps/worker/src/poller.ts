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
  successes: number;
  failures: number;
  rateLimited: boolean;
}

/**
 * One poll pass over every target. Individual request failures are logged and
 * counted; only database errors propagate. source_health for `okx` is updated
 * once per cycle: success if at least one OKX request succeeded.
 */
export async function runPollCycle(options: CycleOptions): Promise<CycleResult> {
  const { client, store, targets, log } = options;
  const candleRequests = options.candleRequests ?? DEFAULT_CANDLE_REQUESTS;
  let successes = 0;
  let failures = 0;
  let rateLimited = false;
  let lastError = "";

  const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
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

  for (const target of targets) {
    const ticker = await attempt(`ticker ${target.instId}`, () => client.getTicker(target.instId));
    if (ticker) {
      await store.upsertQuote(target.symbol, "okx", { symbol: target.symbol, price: ticker.last, ts: ticker.ts });
    }

    for (const request of candleRequests) {
      const parsed = await attempt(`candles ${request.interval} ${target.instId}`, () =>
        client.getCandles(target.instId, request.bar, request.limit),
      );
      if (!parsed) continue;
      if (parsed.rejected > 0) {
        log(`rejected ${parsed.rejected} malformed candle rows for ${target.instId} ${request.interval}`);
      }
      await store.upsertCandles(target.symbol, "okx", request.interval, parsed.candles);
    }
  }

  if (successes > 0) {
    await store.recordSourceSuccess("okx");
  } else if (failures > 0) {
    await store.recordSourceFailure("okx", lastError);
  }

  return { successes, failures, rateLimited };
}
