// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import { OkxRateLimitError, type OkxInstrument, type OkxTicker, type ParsedCandles } from "./okx.ts";
import { pickSwapInstId } from "./symbols.ts";
import type { Candle, Interval, Source } from "./types.ts";

export interface MarketDataSource {
  getTicker(instId: string): Promise<OkxTicker>;
  getCandles(instId: string, bar: string, limit: number): Promise<ParsedCandles>;
}

export interface QuoteRow {
  symbol: string;
  price: number;
  ts: number;
}

/** Persistence used by the collector. The worker (pg) and the Edge Function (PostgREST) each implement it. */
export interface CollectorStore {
  upsertQuote(symbol: string, source: Source, quote: QuoteRow): Promise<void>;
  upsertCandles(symbol: string, source: Source, interval: Interval, candles: readonly Candle[]): Promise<number>;
  recordSourceSuccess(source: Source): Promise<void>;
  recordSourceFailure(source: Source, error: string): Promise<void>;
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
  store: CollectorStore;
  targets: readonly PollTarget[];
  candleRequests?: readonly CandleRequest[];
  /** Number of targets polled in parallel. Defaults to 1, which polls in order. */
  concurrency?: number;
  /** Epoch milliseconds after which no further target is started. */
  deadlineMs?: number;
  now?: () => number;
  log: (message: string) => void;
}

export interface CycleResult {
  /** OKX requests that returned data. */
  successes: number;
  /** OKX requests that failed after client-side retries. */
  failures: number;
  /** Database writes that failed. The cycle continues past each one. */
  writeErrors: number;
  /** Database writes that persisted at least one row. */
  persisted: number;
  rateLimited: boolean;
  /** Targets not started because the deadline had passed. */
  skippedTargets: number;
}

export async function runConcurrently<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(Math.floor(limit), items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor] as T;
      cursor += 1;
      await task(item);
    }
  });
  await Promise.all(lanes);
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
  const now = options.now ?? Date.now;
  let successes = 0;
  let failures = 0;
  let writeErrors = 0;
  let persisted = 0;
  let skippedTargets = 0;
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

  const pollTarget = async (target: PollTarget): Promise<void> => {
    if (options.deadlineMs !== undefined && now() >= options.deadlineMs) {
      skippedTargets += 1;
      return;
    }

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
  };

  await runConcurrently(targets, options.concurrency ?? 1, pollTarget);

  if (persisted > 0) {
    await store.recordSourceSuccess("okx");
  } else if (failures > 0 || writeErrors > 0) {
    await store.recordSourceFailure("okx", lastError);
  }

  return { successes, failures, writeErrors, persisted, rateLimited, skippedTargets };
}

export interface SymbolRecord {
  symbol: string;
  okxInstId: string | null;
}

export interface ResolveTargetsOptions {
  getInstruments: () => Promise<readonly OkxInstrument[]>;
  saveInstId: (symbol: string, instId: string) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Symbols with a stored OKX instrument are polled as-is. Symbols without one are resolved
 * against the live SWAP list and saved; the instrument list is fetched at most once per call.
 */
export async function resolvePollTargets(
  records: readonly SymbolRecord[],
  options: ResolveTargetsOptions,
): Promise<PollTarget[]> {
  const targets: PollTarget[] = [];
  let instruments: readonly OkxInstrument[] | null = null;
  for (const record of records) {
    if (record.okxInstId) {
      targets.push({ symbol: record.symbol, instId: record.okxInstId });
      continue;
    }
    instruments ??= await options.getInstruments();
    const instId = pickSwapInstId(record.symbol, instruments);
    if (!instId) {
      options.log(`no live OKX perpetual found for ${record.symbol}; skipping`);
      continue;
    }
    await options.saveInstId(record.symbol, instId);
    targets.push({ symbol: record.symbol, instId });
  }
  return targets;
}
