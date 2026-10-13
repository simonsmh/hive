import { describe, expect, it } from "vitest";
import { OkxError, OkxRateLimitError, type Candle, type ParsedCandles } from "@hive/core";
import { DEFAULT_CANDLE_REQUESTS, runPollCycle, type MarketDataSource } from "./poller.js";
import type { QuoteRow, Store } from "./store.js";

function candle(ts: number): Candle {
  return { ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 15, confirmed: true };
}

function fakeStore() {
  const calls: string[] = [];
  const store: Store = {
    async upsertSymbolMap() {},
    async upsertQuote(symbol: string, _source, quote: QuoteRow) {
      calls.push(`quote:${symbol}:${quote.price}`);
    },
    async upsertCandles(symbol, _source, interval, candles) {
      calls.push(`candles:${symbol}:${interval}:${candles.length}`);
      return candles.length;
    },
    async recordSourceSuccess() {
      calls.push("health:success");
    },
    async recordSourceFailure(_source, error) {
      calls.push(`health:failure:${error}`);
    },
  };
  return { store, calls };
}

const targets = [{ symbol: "NVDA", instId: "NVDA-USDT-SWAP" }];
const twoTargets = [
  { symbol: "NVDA", instId: "NVDA-USDT-SWAP" },
  { symbol: "BTC", instId: "BTC-USDT-SWAP" },
];
const quietLog = () => undefined;

function okClient(): MarketDataSource {
  return {
    async getTicker(instId) {
      return { instId, last: 100, ts: 1000 };
    },
    async getCandles(): Promise<ParsedCandles> {
      return { candles: [candle(1)], rejected: 0 };
    },
  };
}

describe("runPollCycle", () => {
  it("writes quotes and candles and records a healthy source", async () => {
    const { store, calls } = fakeStore();
    const client: MarketDataSource = {
      async getTicker() {
        return { instId: "NVDA-USDT-SWAP", last: 180.5, ts: 1000 };
      },
      async getCandles(): Promise<ParsedCandles> {
        return { candles: [candle(1), candle(2)], rejected: 0 };
      },
    };
    const result = await runPollCycle({
      client,
      store,
      targets,
      candleRequests: [{ interval: "1m", bar: "1m", limit: 2 }],
      log: quietLog,
    });
    expect(result).toEqual({ successes: 2, failures: 0, writeErrors: 0, rateLimited: false });
    expect(calls).toEqual(["quote:NVDA:180.5", "candles:NVDA:1m:2", "health:success"]);
  });

  it("keeps polling later symbols and still records health when one candle write fails", async () => {
    const { store, calls } = fakeStore();
    const flakyStore: Store = {
      ...store,
      async upsertCandles(symbol, source, interval, candles) {
        if (symbol === "NVDA") throw new Error("connection reset");
        return store.upsertCandles(symbol, source, interval, candles);
      },
    };
    const result = await runPollCycle({
      client: okClient(),
      store: flakyStore,
      targets: twoTargets,
      candleRequests: [{ interval: "1m", bar: "1m", limit: 1 }],
      log: quietLog,
    });
    expect(result).toEqual({ successes: 4, failures: 0, writeErrors: 1, rateLimited: false });
    expect(calls).toEqual(["quote:NVDA:100", "quote:BTC:100", "candles:BTC:1m:1", "health:success"]);
  });

  it("does not count an empty candle batch as a persisted write", async () => {
    const { store, calls } = fakeStore();
    const client: MarketDataSource = {
      async getTicker(instId) {
        return { instId, last: 100, ts: 1000 };
      },
      async getCandles(): Promise<ParsedCandles> {
        return { candles: [], rejected: 0 };
      },
    };
    const deadQuotes: Store = {
      ...store,
      async upsertQuote() {
        throw new Error("db down");
      },
    };
    await runPollCycle({
      client,
      store: deadQuotes,
      targets,
      candleRequests: [{ interval: "1m", bar: "1m", limit: 1 }],
      log: quietLog,
    });
    expect(calls).toEqual(["health:failure:quote NVDA: db down"]);
  });

  it("records a source failure with the database error when no write lands", async () => {
    const { store, calls } = fakeStore();
    const deadStore: Store = {
      ...store,
      async upsertQuote() {
        throw new Error("db unavailable");
      },
      async upsertCandles() {
        throw new Error("db unavailable");
      },
    };
    const result = await runPollCycle({
      client: okClient(),
      store: deadStore,
      targets: twoTargets,
      candleRequests: [{ interval: "1m", bar: "1m", limit: 1 }],
      log: quietLog,
    });
    expect(result).toEqual({ successes: 4, failures: 0, writeErrors: 4, rateLimited: false });
    expect(calls).toEqual(["health:failure:candles 1m BTC: db unavailable"]);
  });

  it("flags rate limiting and records a failure when every request fails", async () => {
    const { store, calls } = fakeStore();
    const client: MarketDataSource = {
      async getTicker() {
        throw new OkxRateLimitError("OKX /ticker returned HTTP 429", 429);
      },
      async getCandles() {
        throw new OkxRateLimitError("OKX /candles returned HTTP 429", 429);
      },
    };
    const result = await runPollCycle({
      client,
      store,
      targets,
      candleRequests: [{ interval: "5m", bar: "5m", limit: 2 }],
      log: quietLog,
    });
    expect(result).toEqual({ successes: 0, failures: 2, writeErrors: 0, rateLimited: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^health:failure:candles 5m NVDA-USDT-SWAP: OKX/);
  });

  it("keeps polling other intervals when one request fails", async () => {
    const { store, calls } = fakeStore();
    const client: MarketDataSource = {
      async getTicker() {
        throw new OkxError("boom", 500);
      },
      async getCandles(_instId, bar) {
        if (bar === "5m") throw new OkxError("boom", 500);
        return { candles: [candle(1)], rejected: 2 };
      },
    };
    const result = await runPollCycle({
      client,
      store,
      targets,
      candleRequests: [
        { interval: "1m", bar: "1m", limit: 1 },
        { interval: "5m", bar: "5m", limit: 1 },
      ],
      log: quietLog,
    });
    expect(result).toEqual({ successes: 1, failures: 2, writeErrors: 0, rateLimited: false });
    expect(calls).toContain("candles:NVDA:1m:1");
    expect(calls).toContain("health:success");
  });
});

describe("default candle requests", () => {
  it("requests UTC daily bars so weekday filtering uses UTC calendar days", () => {
    expect(DEFAULT_CANDLE_REQUESTS.find((r) => r.interval === "1D")).toEqual({ interval: "1D", bar: "1Dutc", limit: 60 });
  });
});
