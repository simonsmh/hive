import { describe, expect, it } from "vitest";
import type { CollectorStore, MarketDataSource, QuoteRow } from "./collector.js";
import { DEFAULT_CANDLE_REQUESTS, resolvePollTargets, runPollCycle } from "./collector.js";
import { OkxError, OkxRateLimitError, type OkxInstrument, type ParsedCandles } from "./okx.js";
import type { Candle } from "./types.js";

function candle(ts: number): Candle {
  return { ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 15, confirmed: true };
}

function fakeStore() {
  const calls: string[] = [];
  const store: CollectorStore = {
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
    expect(result).toEqual({ successes: 2, failures: 0, writeErrors: 0, persisted: 2, rateLimited: false, skippedTargets: 0 });
    expect(calls).toEqual(["quote:NVDA:180.5", "candles:NVDA:1m:2", "health:success"]);
  });

  it("keeps polling later symbols and still records health when one candle write fails", async () => {
    const { store, calls } = fakeStore();
    const flakyStore: CollectorStore = {
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
    expect(result).toEqual({ successes: 4, failures: 0, writeErrors: 1, persisted: 3, rateLimited: false, skippedTargets: 0 });
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
    const deadQuotes: CollectorStore = {
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
    const deadStore: CollectorStore = {
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
    expect(result).toEqual({ successes: 4, failures: 0, writeErrors: 4, persisted: 0, rateLimited: false, skippedTargets: 0 });
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
    expect(result).toEqual({ successes: 0, failures: 2, writeErrors: 0, persisted: 0, rateLimited: true, skippedTargets: 0 });
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
    expect(result).toEqual({ successes: 1, failures: 2, writeErrors: 0, persisted: 1, rateLimited: false, skippedTargets: 0 });
    expect(calls).toContain("candles:NVDA:1m:1");
    expect(calls).toContain("health:success");
  });

  it("polls targets in parallel up to the concurrency limit and still records health once", async () => {
    const { store, calls } = fakeStore();
    let inFlight = 0;
    let peak = 0;
    const client: MarketDataSource = {
      async getTicker(instId) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { instId, last: 1, ts: 1 };
      },
      async getCandles(): Promise<ParsedCandles> {
        return { candles: [], rejected: 0 };
      },
    };
    const many = ["A", "B", "C", "D", "E"].map((symbol) => ({ symbol, instId: `${symbol}-USDT-SWAP` }));
    const result = await runPollCycle({
      client,
      store,
      targets: many,
      candleRequests: [],
      concurrency: 2,
      log: quietLog,
    });
    expect(peak).toBe(2);
    expect(result.persisted).toBe(5);
    expect(calls.filter((c) => c === "health:success")).toHaveLength(1);
  });

  it("skips targets that start after the deadline", async () => {
    const { store, calls } = fakeStore();
    let clock = 0;
    const client: MarketDataSource = {
      async getTicker(instId) {
        clock += 100;
        return { instId, last: 1, ts: 1 };
      },
      async getCandles(): Promise<ParsedCandles> {
        return { candles: [], rejected: 0 };
      },
    };
    const many = ["A", "B", "C"].map((symbol) => ({ symbol, instId: `${symbol}-USDT-SWAP` }));
    const result = await runPollCycle({
      client,
      store,
      targets: many,
      candleRequests: [],
      deadlineMs: 50,
      now: () => clock,
      log: quietLog,
    });
    expect(result.skippedTargets).toBe(2);
    expect(result.persisted).toBe(1);
    expect(calls).toEqual(["quote:A:1", "health:success"]);
  });
});

describe("resolvePollTargets", () => {
  const instruments: OkxInstrument[] = [
    { instId: "ETH-USDT-SWAP", instType: "SWAP", state: "live" },
    { instId: "NVDA-USD-SWAP", instType: "SWAP", state: "live" },
    { instId: "OLD-USDT-SWAP", instType: "SWAP", state: "suspend" },
  ];

  it("uses stored instrument ids without fetching the instrument list", async () => {
    let fetched = 0;
    const targets = await resolvePollTargets([{ symbol: "BTC", okxInstId: "BTC-USDT-SWAP" }], {
      getInstruments: async () => {
        fetched += 1;
        return instruments;
      },
      saveInstId: async () => undefined,
      log: quietLog,
    });
    expect(targets).toEqual([{ symbol: "BTC", instId: "BTC-USDT-SWAP" }]);
    expect(fetched).toBe(0);
  });

  it("resolves missing ids once, saves them, and skips symbols with no live perpetual", async () => {
    let fetched = 0;
    const saved: Array<[string, string]> = [];
    const logs: string[] = [];
    const targets = await resolvePollTargets(
      [
        { symbol: "ETH", okxInstId: null },
        { symbol: "NVDA", okxInstId: null },
        { symbol: "OLD", okxInstId: null },
      ],
      {
        getInstruments: async () => {
          fetched += 1;
          return instruments;
        },
        saveInstId: async (symbol, instId) => {
          saved.push([symbol, instId]);
        },
        log: (message) => logs.push(message),
      },
    );
    expect(targets).toEqual([
      { symbol: "ETH", instId: "ETH-USDT-SWAP" },
      { symbol: "NVDA", instId: "NVDA-USD-SWAP" },
    ]);
    expect(saved).toEqual([
      ["ETH", "ETH-USDT-SWAP"],
      ["NVDA", "NVDA-USD-SWAP"],
    ]);
    expect(fetched).toBe(1);
    expect(logs).toEqual(["no live OKX perpetual found for OLD; skipping"]);
  });
});

describe("default candle requests", () => {
  it("requests UTC daily bars so weekday filtering uses UTC calendar days", () => {
    expect(DEFAULT_CANDLE_REQUESTS.find((r) => r.interval === "1D")).toEqual({ interval: "1D", bar: "1Dutc", limit: 60 });
  });
});
