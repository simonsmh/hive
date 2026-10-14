import { describe, expect, it } from "vitest";
import type { CollectorStore, QuoteRow } from "./collector.js";
import { runYahooCycle, DAILY_REFRESH_MS } from "./yahoo-cycle.js";
import { YahooError, YahooRateLimitError, type YahooChart, type YahooMarketData } from "./yahoo.js";
import type { Candle } from "./types.js";

function bar(ts: number, close = 100): Candle {
  return { ts, open: close, high: close, low: close, close, volume: 1, volCcy: 0, confirmed: true };
}

function chart(candles: Candle[], quote: YahooChart["quote"] = null): YahooChart {
  return { candles, quote, rejected: 0 };
}

function fakeStore(options: { failQuotesFor?: string } = {}) {
  const calls: string[] = [];
  const store: CollectorStore = {
    async upsertQuote(symbol, source, quote: QuoteRow) {
      if (symbol === options.failQuotesFor) throw new Error("db down");
      calls.push(`quote:${source}:${symbol}:${quote.price}:${quote.ts}`);
    },
    async upsertCandles(symbol, source, interval, candles) {
      calls.push(`candles:${source}:${symbol}:${interval}:${candles.length}`);
      return candles.length;
    },
    async recordSourceSuccess(source) {
      calls.push(`health:success:${source}`);
    },
    async recordSourceFailure(source, error) {
      calls.push(`health:failure:${source}:${error}`);
    },
  };
  return { store, calls };
}

interface FakeClientOptions {
  intraday?: (symbol: string) => Promise<YahooChart>;
  daily?: (symbol: string) => Promise<YahooChart>;
}

function fakeClient(options: FakeClientOptions = {}) {
  const requests: string[] = [];
  const client: YahooMarketData = {
    async getIntraday(symbol) {
      requests.push(`intraday:${symbol}`);
      return options.intraday ? options.intraday(symbol) : chart([bar(1), bar(2)], { price: 102, ts: 2 });
    },
    async getDaily(symbol) {
      requests.push(`daily:${symbol}`);
      return options.daily ? options.daily(symbol) : chart([bar(10), bar(20)]);
    },
  };
  return { client, requests };
}

const quietLog = () => undefined;
const nvda = [{ symbol: "NVDA", instId: "NVDA" }];
const pair = [
  { symbol: "NVDA", instId: "NVDA" },
  { symbol: "BZ", instId: "BZ=F" },
];

describe("runYahooCycle", () => {
  it("writes the quote, the newest 1m bars and daily bars, then records a healthy source", async () => {
    const { store, calls } = fakeStore();
    const { client, requests } = fakeClient({
      intraday: async () => chart([bar(1), bar(2), bar(3), bar(4)], { price: 104, ts: 4 }),
    });
    const result = await runYahooCycle({ client, store, targets: nvda, intradayBars: 2, log: quietLog });

    expect(result).toEqual({ successes: 2, failures: 0, writeErrors: 0, persisted: 3, rateLimited: false, skippedTargets: 0 });
    expect(requests).toEqual(["intraday:NVDA", "daily:NVDA"]);
    expect(calls).toEqual([
      "quote:yahoo:NVDA:104:4",
      "candles:yahoo:NVDA:1m:2",
      "candles:yahoo:NVDA:1D:2",
      "health:success:yahoo",
    ]);
  });

  it("does not refetch daily bars until the refresh interval has passed", async () => {
    const dailyWrittenAt = new Map<string, number>();
    const { store } = fakeStore();
    const { client, requests } = fakeClient();
    let clock = 1_000_000;
    const run = () => runYahooCycle({ client, store, targets: nvda, dailyWrittenAt, now: () => clock, log: quietLog });

    await run();
    clock += DAILY_REFRESH_MS - 1;
    await run();
    expect(requests.filter((r) => r.startsWith("daily"))).toHaveLength(1);

    clock += 1;
    await run();
    expect(requests.filter((r) => r.startsWith("daily"))).toHaveLength(2);
  });

  it("retries the daily request on the next run when its write failed", async () => {
    const dailyWrittenAt = new Map<string, number>();
    let failDaily = true;
    const dailyStore: CollectorStore = {
      ...fakeStore().store,
      async upsertCandles(_symbol, _source, interval, candles) {
        if (interval === "1D" && failDaily) throw new Error("write timeout");
        return candles.length;
      },
    };
    const { client, requests } = fakeClient();
    await runYahooCycle({ client, store: dailyStore, targets: nvda, dailyWrittenAt, log: quietLog });
    expect(dailyWrittenAt.has("NVDA")).toBe(false);

    failDaily = false;
    await runYahooCycle({ client, store: dailyStore, targets: nvda, dailyWrittenAt, log: quietLog });
    expect(requests.filter((r) => r.startsWith("daily"))).toHaveLength(2);
    expect(dailyWrittenAt.has("NVDA")).toBe(true);
  });

  it("keeps polling other symbols when one symbol's request fails, and counts the failure", async () => {
    const { store, calls } = fakeStore();
    const { client } = fakeClient({
      intraday: async (symbol) => {
        if (symbol === "NVDA") throw new YahooError("yahoo chart NVDA returned HTTP 500", 500);
        return chart([bar(1)], { price: 50, ts: 1 });
      },
      daily: async () => chart([]),
    });
    const result = await runYahooCycle({ client, store, targets: pair, log: quietLog });

    expect(result).toMatchObject({ failures: 1, persisted: 2, writeErrors: 0, successes: 3 });
    expect(calls).toContain("quote:yahoo:BZ:50:1");
    expect(calls.at(-1)).toBe("health:success:yahoo");
  });

  it("keeps the cycle going when one write fails, and reports the write error only if nothing persisted", async () => {
    const { store, calls } = fakeStore({ failQuotesFor: "NVDA" });
    const { client } = fakeClient({ daily: async () => chart([]) });
    const result = await runYahooCycle({ client, store, targets: pair, log: quietLog });

    expect(result.writeErrors).toBe(1);
    expect(calls).toContain("health:success:yahoo");
  });

  it("records a failure with the last error when nothing persists", async () => {
    const { store, calls } = fakeStore();
    const { client } = fakeClient({
      intraday: async () => {
        throw new YahooError("yahoo chart NVDA returned HTTP 404: Not Found");
      },
      daily: async () => {
        throw new YahooError("yahoo chart NVDA returned HTTP 404: Not Found");
      },
    });
    const result = await runYahooCycle({ client, store, targets: nvda, log: quietLog });

    expect(result).toMatchObject({ successes: 0, failures: 2, persisted: 0 });
    expect(calls).toEqual(["health:failure:yahoo:daily NVDA: yahoo chart NVDA returned HTTP 404: Not Found"]);
  });

  it("stops sending requests after a rate-limit response and flags the run", async () => {
    const { store, calls } = fakeStore();
    const { client, requests } = fakeClient({
      intraday: async () => {
        throw new YahooRateLimitError("yahoo chart NVDA returned HTTP 429", 429);
      },
    });
    const result = await runYahooCycle({ client, store, targets: pair, concurrency: 1, log: quietLog });

    expect(result).toEqual({ successes: 0, failures: 1, writeErrors: 0, persisted: 0, rateLimited: true, skippedTargets: 1 });
    expect(requests).toEqual(["intraday:NVDA"]);
    expect(calls).toEqual(["health:failure:yahoo:intraday NVDA: yahoo chart NVDA returned HTTP 429"]);
  });

  it("does not start targets once the deadline has passed", async () => {
    const { store } = fakeStore();
    let clock = 0;
    const { client, requests } = fakeClient({
      intraday: async () => {
        clock += 100;
        return chart([bar(1)], { price: 1, ts: 1 });
      },
      daily: async () => chart([]),
    });
    const many = ["A", "B", "C"].map((symbol) => ({ symbol, instId: symbol }));
    const result = await runYahooCycle({ client, store, targets: many, deadlineMs: 50, now: () => clock, log: quietLog });

    expect(result.skippedTargets).toBe(2);
    expect(requests).toEqual(["intraday:A", "daily:A"]);
  });

  it("writes nothing and records nothing when Yahoo returns no data for any symbol", async () => {
    const { store, calls } = fakeStore();
    const { client } = fakeClient({ intraday: async () => chart([]), daily: async () => chart([]) });
    const result = await runYahooCycle({ client, store, targets: nvda, log: quietLog });

    expect(result).toMatchObject({ persisted: 0, failures: 0, writeErrors: 0 });
    expect(calls).toEqual([]);
  });
});
