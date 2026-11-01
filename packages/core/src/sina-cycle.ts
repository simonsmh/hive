import { runConcurrently, type CycleResult } from "./collector.js";
import { SinaRateLimitError, type SinaDaily, type SinaMarketData } from "./sina.js";
import type { Candle, Source } from "./types.js";

export const SINA_SOURCE = "sina" as const;

export interface SinaStore {
  upsertCandles(symbol: string, source: Source, interval: "1D", candles: readonly Candle[]): Promise<number>;
  recordSourceSuccess(source: Source): Promise<void>;
  recordSourceFailure(source: Source, error: string): Promise<void>;
}

export interface SinaTarget {
  symbol: string;
  /** Sina code derived from ths_code, for example sh600487. */
  sinaCode: string;
}

export interface SinaCycleOptions {
  client: SinaMarketData;
  store: SinaStore;
  targets: readonly SinaTarget[];
  concurrency?: number;
  /** Epoch milliseconds after which no further target is started. */
  deadlineMs?: number;
  now?: () => number;
  log: (message: string) => void;
}

/**
 * One Sina daily poll pass. Each target gets one K-line request and its
 * 1D bars are upserted under source 'sina'. The upsert is idempotent on
 * (symbol, source, interval, ts), so a rerun writes the same rows again
 * without duplicating or drifting them; a bar promoted from unconfirmed to
 * confirmed (today's bar after the close) is simply overwritten with the
 * new flag. Failures are counted per request and per write, so one bad
 * symbol does not stop the rest. source_health for `sina` is updated once
 * per run: success if at least one row was persisted, failure if none was
 * and something went wrong. After a rate-limit response no further requests
 * are sent in this run.
 */
export async function runSinaCycle(options: SinaCycleOptions): Promise<CycleResult> {
  const { client, store, targets, log } = options;
  const now = options.now ?? Date.now;
  let successes = 0;
  let failures = 0;
  let writeErrors = 0;
  let persisted = 0;
  let skippedTargets = 0;
  let rateLimited = false;
  let lastError = "";

  const fetchDaily = async (target: SinaTarget): Promise<SinaDaily | null> => {
    try {
      const daily = await client.getDaily(target.sinaCode);
      successes += 1;
      return daily;
    } catch (error) {
      failures += 1;
      if (error instanceof SinaRateLimitError) rateLimited = true;
      lastError = `daily ${target.symbol}: ${(error as Error).message}`;
      log(`sina request failed (daily ${target.symbol}): ${(error as Error).message}`);
      return null;
    }
  };

  const persist = async (target: SinaTarget, candles: readonly Candle[]): Promise<boolean> => {
    try {
      await store.upsertCandles(target.symbol, SINA_SOURCE, "1D", candles);
      persisted += 1;
      return true;
    } catch (error) {
      writeErrors += 1;
      lastError = `candles 1D ${target.symbol}: ${(error as Error).message}`;
      log(`database write failed (candles 1D ${target.symbol}): ${(error as Error).message}`);
      return false;
    }
  };

  const pollTarget = async (target: SinaTarget): Promise<void> => {
    if (rateLimited || (options.deadlineMs !== undefined && now() >= options.deadlineMs)) {
      skippedTargets += 1;
      return;
    }
    const daily = await fetchDaily(target);
    if (!daily) return;
    if (daily.rejected > 0) log(`rejected ${daily.rejected} malformed bars for ${target.symbol} (1D)`);
    if (daily.candles.length === 0) return;
    await persist(target, daily.candles);
  };

  await runConcurrently(targets, options.concurrency ?? 1, pollTarget);

  if (persisted > 0) {
    await store.recordSourceSuccess(SINA_SOURCE);
  } else if (failures > 0 || writeErrors > 0) {
    await store.recordSourceFailure(SINA_SOURCE, lastError);
  }

  return { successes, failures, writeErrors, persisted, rateLimited, skippedTargets };
}
