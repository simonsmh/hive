import { runConcurrently, type CycleResult } from "./collector.js";
import { SinaRateLimitError, type SinaIntraday, type SinaIntradayData } from "./sina.js";
import type { Candle, Source } from "./types.js";

const SINA_SOURCE = "sina" as const;
/** Five-minute bars, matching the alert-evaluator's 5m volume_spike interval. */
export const INTRADAY_INTERVAL_MINUTES = 5;

export interface SinaIntradayStore {
  upsertCandles(symbol: string, source: Source, interval: "5m" | "15m", candles: readonly Candle[]): Promise<number>;
  recordSourceSuccess(source: Source): Promise<void>;
  recordSourceFailure(source: Source, error: string): Promise<void>;
}

const FIVE_MINUTES_MS = 5 * 60_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;

/**
 * Aggregates confirmed 5m bars into 15m bars for rules that read a 15m series (for example the
 * retracement turning-point rules). A-share 15m windows align to the clock (09:30, 09:45, ...), so the
 * window start is the floor of the bar timestamp. A window is emitted only when all three of its 5m bars
 * are present and confirmed, so a gap in the 5m series or an in-progress bar never produces a misleading
 * 15m bar. The aggregation is idempotent: the same 5m bars always build the same 15m bar, and the upsert
 * key is (symbol, source, interval, ts).
 */
export function aggregate15m(candles: readonly Candle[]): Candle[] {
  const byWindow = new Map<number, Candle[]>();
  for (const candle of candles) {
    const start = Math.floor(candle.ts / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
    const list = byWindow.get(start) ?? [];
    list.push(candle);
    byWindow.set(start, list);
  }
  const out: Candle[] = [];
  for (const [start, bars] of [...byWindow.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length !== 3) continue;
    const sorted = [...bars].sort((a, b) => a.ts - b.ts);
    if (
      sorted[0]!.ts !== start ||
      sorted[1]!.ts !== start + FIVE_MINUTES_MS ||
      sorted[2]!.ts !== start + 2 * FIVE_MINUTES_MS ||
      !sorted.every((bar) => bar.confirmed)
    ) {
      continue;
    }
    out.push({
      ts: start,
      open: sorted[0]!.open,
      high: Math.max(...sorted.map((bar) => bar.high)),
      low: Math.min(...sorted.map((bar) => bar.low)),
      close: sorted[2]!.close,
      volume: sorted.reduce((sum, bar) => sum + bar.volume, 0),
      volCcy: sorted.reduce((sum, bar) => sum + bar.volCcy, 0),
      confirmed: true,
    });
  }
  return out;
}

export interface SinaIntradayTarget {
  symbol: string;
  /** Sina code derived from ths_code, for example sh513310. */
  sinaCode: string;
}

export interface SinaIntradayCycleOptions {
  client: SinaIntradayData;
  store: SinaIntradayStore;
  targets: readonly SinaIntradayTarget[];
  concurrency?: number;
  /** Epoch milliseconds after which no further target is started. */
  deadlineMs?: number;
  now?: () => number;
  log: (message: string) => void;
}

/**
 * One Sina intraday poll pass. Each target gets one K-line request and its
 * 5m bars are upserted under source 'sina', together with the 15m bars
 * aggregated from the complete confirmed 5m windows (see aggregate15m).
 * The upsert is idempotent on (symbol, source, interval, ts), so a rerun writes the same rows again
 * without duplicating or drifting them; a bar promoted from unconfirmed to
 * confirmed (its window just ended) is simply overwritten with the new
 * flag. Failures are counted per request and per write, so one bad symbol
 * does not stop the rest. source_health for `sina` is updated once per
 * run: success if at least one row was persisted, failure if none was and
 * something went wrong. After a rate-limit response no further requests
 * are sent in this run.
 */
export async function runSinaIntradayCycle(options: SinaIntradayCycleOptions): Promise<CycleResult> {
  const { client, store, targets, log } = options;
  const now = options.now ?? Date.now;
  let successes = 0;
  let failures = 0;
  let writeErrors = 0;
  let persisted = 0;
  let skippedTargets = 0;
  let rateLimited = false;
  let lastError = "";

  const fetchIntraday = async (target: SinaIntradayTarget): Promise<SinaIntraday | null> => {
    try {
      const intraday = await client.getIntraday(target.sinaCode, INTRADAY_INTERVAL_MINUTES);
      successes += 1;
      return intraday;
    } catch (error) {
      failures += 1;
      if (error instanceof SinaRateLimitError) rateLimited = true;
      lastError = `intraday ${target.symbol}: ${(error as Error).message}`;
      log(`sina request failed (intraday ${target.symbol}): ${(error as Error).message}`);
      return null;
    }
  };

  const persist = async (target: SinaIntradayTarget, candles: readonly Candle[]): Promise<boolean> => {
    try {
      await store.upsertCandles(target.symbol, SINA_SOURCE, "5m", candles);
    } catch (error) {
      writeErrors += 1;
      lastError = `candles 5m ${target.symbol}: ${(error as Error).message}`;
      log(`database write failed (candles 5m ${target.symbol}): ${(error as Error).message}`);
      return false;
    }
    const bars15m = aggregate15m(candles);
    if (bars15m.length > 0) {
      try {
        await store.upsertCandles(target.symbol, SINA_SOURCE, "15m", bars15m);
      } catch (error) {
        writeErrors += 1;
        lastError = `candles 15m ${target.symbol}: ${(error as Error).message}`;
        log(`database write failed (candles 15m ${target.symbol}): ${(error as Error).message}`);
        return false;
      }
    }
    persisted += 1;
    return true;
  };

  const pollTarget = async (target: SinaIntradayTarget): Promise<void> => {
    if (rateLimited || (options.deadlineMs !== undefined && now() >= options.deadlineMs)) {
      skippedTargets += 1;
      return;
    }
    const intraday = await fetchIntraday(target);
    if (!intraday) return;
    if (intraday.rejected > 0) log(`rejected ${intraday.rejected} malformed bars for ${target.symbol} (5m)`);
    if (intraday.candles.length === 0) return;
    await persist(target, intraday.candles);
  };

  await runConcurrently(targets, options.concurrency ?? 1, pollTarget);

  if (persisted > 0) {
    await store.recordSourceSuccess(SINA_SOURCE);
  } else if (failures > 0 || writeErrors > 0) {
    await store.recordSourceFailure(SINA_SOURCE, lastError);
  }

  return { successes, failures, writeErrors, persisted, rateLimited, skippedTargets };
}
