// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import { runConcurrently, type CollectorStore, type CycleResult, type PollTarget } from "./collector.ts";
import { YahooRateLimitError, type YahooChart, type YahooMarketData } from "./yahoo.ts";

export const YAHOO_SOURCE = "yahoo" as const;
/** 1m bars written per symbol per run. Each run fetches the whole session and keeps the newest of them. */
export const INTRADAY_BARS = 60;
/** Daily bars close once a day, so each symbol's daily request runs at most this often. */
export const DAILY_REFRESH_MS = 60 * 60_000;

export interface YahooCycleOptions {
  client: YahooMarketData;
  store: CollectorStore;
  /** For this source, `instId` holds the Yahoo symbol. */
  targets: readonly PollTarget[];
  /** Pass the same map to every run. It records when each symbol's daily bars were last written. */
  dailyWrittenAt?: Map<string, number>;
  intradayBars?: number;
  dailyRefreshMs?: number;
  concurrency?: number;
  /** Epoch milliseconds after which no further target is started. */
  deadlineMs?: number;
  now?: () => number;
  log: (message: string) => void;
}

/**
 * One Yahoo poll pass. Each symbol gets one intraday request, which supplies both the quote and the 1m bars, plus a
 * daily request at most once per DAILY_REFRESH_MS. Failures are counted per request and per write, as in
 * runPollCycle. source_health for `yahoo` is updated once per run: success if at least one row was persisted, failure if
 * none was and something went wrong. After a rate-limit response no further requests are sent in this run, because
 * Yahoo throttles by address.
 */
export async function runYahooCycle(options: YahooCycleOptions): Promise<CycleResult> {
  const { client, store, targets, log } = options;
  const now = options.now ?? Date.now;
  const intradayBars = options.intradayBars ?? INTRADAY_BARS;
  const dailyRefreshMs = options.dailyRefreshMs ?? DAILY_REFRESH_MS;
  const dailyWrittenAt = options.dailyWrittenAt ?? new Map<string, number>();
  let successes = 0;
  let failures = 0;
  let writeErrors = 0;
  let persisted = 0;
  let skippedTargets = 0;
  let rateLimited = false;
  let lastError = "";

  const fetchChart = async (label: string, fn: () => Promise<YahooChart>): Promise<YahooChart | null> => {
    try {
      const chart = await fn();
      successes += 1;
      return chart;
    } catch (error) {
      failures += 1;
      if (error instanceof YahooRateLimitError) rateLimited = true;
      const message = (error as Error).message;
      lastError = `${label}: ${message}`;
      log(`yahoo request failed (${label}): ${message}`);
      return null;
    }
  };

  const persist = async (label: string, write: () => Promise<unknown>): Promise<boolean> => {
    try {
      await write();
      persisted += 1;
      return true;
    } catch (error) {
      writeErrors += 1;
      lastError = `${label}: ${(error as Error).message}`;
      log(`database write failed (${label}): ${(error as Error).message}`);
      return false;
    }
  };

  const pollTarget = async (target: PollTarget): Promise<void> => {
    if (rateLimited || (options.deadlineMs !== undefined && now() >= options.deadlineMs)) {
      skippedTargets += 1;
      return;
    }
    const symbol = target.symbol;

    const intraday = await fetchChart(`intraday ${symbol}`, () => client.getIntraday(target.instId));
    if (intraday) {
      if (intraday.rejected > 0) log(`rejected ${intraday.rejected} malformed bars for ${symbol} (1m)`);
      const quote = intraday.quote;
      if (quote) {
        await persist(`quote ${symbol}`, () => store.upsertQuote(symbol, YAHOO_SOURCE, { symbol, price: quote.price, ts: quote.ts }));
      }
      const bars = intraday.candles.slice(-intradayBars);
      if (bars.length > 0) {
        await persist(`candles 1m ${symbol}`, () => store.upsertCandles(symbol, YAHOO_SOURCE, "1m", bars));
      }
    }

    const lastDaily = dailyWrittenAt.get(symbol);
    if (rateLimited || (lastDaily !== undefined && now() - lastDaily < dailyRefreshMs)) return;

    const daily = await fetchChart(`daily ${symbol}`, () => client.getDaily(target.instId));
    if (!daily) return;
    if (daily.candles.length === 0) {
      dailyWrittenAt.set(symbol, now());
      return;
    }
    const written = await persist(`candles 1D ${symbol}`, () =>
      store.upsertCandles(symbol, YAHOO_SOURCE, "1D", daily.candles),
    );
    if (written) dailyWrittenAt.set(symbol, now());
  };

  await runConcurrently(targets, options.concurrency ?? 1, pollTarget);

  if (persisted > 0) {
    await store.recordSourceSuccess(YAHOO_SOURCE);
  } else if (failures > 0 || writeErrors > 0) {
    await store.recordSourceFailure(YAHOO_SOURCE, lastError);
  }

  return { successes, failures, writeErrors, persisted, rateLimited, skippedTargets };
}
