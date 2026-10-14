import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import { YahooError, YahooRateLimitError, type YahooChart, type YahooMarketData } from "./core/yahoo.ts";
import {
  createYahooCollectorHandler,
  LEASE_SECONDS,
  RATE_LIMIT_BACKOFF_SECONDS,
  toYahooTargets,
  type YahooCollectorStore,
  type YahooSymbolRecord,
} from "./handler.ts";

const SECRET = "test-cron-secret";
const HOLDER = "holder-1";
const NOW = 1_000_000;

const candle: Candle = { ts: 1_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 0, confirmed: true };

function chart(candles: Candle[] = [candle], quote: YahooChart["quote"] = { price: 100, ts: 1_000_000_000 }): YahooChart {
  return { candles, quote, rejected: 0 };
}

interface FakeStoreOptions {
  leaseGranted?: boolean;
  symbols?: YahooSymbolRecord[];
  listSymbolsError?: Error;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const calls: string[] = [];
  const finishes: Array<{ holder: string; outcome: string; backoff: number; summary: Record<string, unknown> }> = [];
  const store: YahooCollectorStore = {
    async beginRun(holder, leaseSeconds) {
      calls.push(`begin:${holder}:${leaseSeconds}`);
      return options.leaseGranted ?? true;
    },
    async finishRun(holder, outcome, backoff, summary) {
      calls.push(`finish:${outcome}`);
      finishes.push({ holder, outcome, backoff, summary });
    },
    async listSymbols() {
      calls.push("list");
      if (options.listSymbolsError) throw options.listSymbolsError;
      return options.symbols ?? [{ symbol: "NVDA", yahooSymbol: "NVDA" }];
    },
    async upsertQuote(symbol, source, quote) {
      calls.push(`quote:${source}:${symbol}:${quote.price}`);
    },
    async upsertCandles(symbol, source, interval, rows) {
      calls.push(`candles:${source}:${symbol}:${interval}:${rows.length}`);
      return rows.length;
    },
    async recordSourceSuccess(source) {
      calls.push(`health:success:${source}`);
    },
    async recordSourceFailure(source, error) {
      calls.push(`health:failure:${source}:${error}`);
    },
  };
  return { store, calls, finishes };
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
      return options.intraday ? options.intraday(symbol) : chart();
    },
    async getDaily(symbol) {
      requests.push(`daily:${symbol}`);
      return options.daily ? options.daily(symbol) : chart([{ ...candle, ts: 2_000_000_000 }], null);
    },
  };
  return { client, requests };
}

function tick(method = "POST", secret: string | null = SECRET): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return new Request("https://functions.test/yahoo-collector", { method, headers });
}

function build(options: FakeStoreOptions & FakeClientOptions & { collectorSecret?: string | undefined } = {}) {
  const fake = fakeStore(options);
  const fakeYahoo = fakeClient(options);
  const handler = createYahooCollectorHandler({
    cronSecret: "collectorSecret" in options ? options.collectorSecret : SECRET,
    store: fake.store,
    client: fakeYahoo.client,
    now: () => NOW,
    newHolder: () => HOLDER,
    log: () => undefined,
  });
  return { handler, ...fake, requests: fakeYahoo.requests };
}

Deno.test("rejects non-POST requests before touching the store", async () => {
  const { handler, calls } = build();
  const response = await handler(tick("GET"));
  strictEqual(response.status, 405);
  strictEqual(response.headers.get("allow"), "POST");
  deepStrictEqual(calls, []);
});

Deno.test("fails closed when EDGE_CRON_SECRET is not configured", async () => {
  const { handler, calls } = build({ collectorSecret: undefined });
  strictEqual((await handler(tick())).status, 500);
  deepStrictEqual(calls, []);
});

Deno.test("rejects missing or wrong bearer tokens without starting a run", async () => {
  const { handler, calls, requests } = build();
  strictEqual((await handler(tick("POST", null))).status, 401);
  strictEqual((await handler(tick("POST", "wrong"))).status, 401);
  deepStrictEqual(calls, []);
  deepStrictEqual(requests, []);
});

Deno.test("skips the tick when another run holds the lease", async () => {
  const { handler, calls, finishes, requests } = build({ leaseGranted: false });
  const response = await handler(tick());
  strictEqual(response.status, 200);
  strictEqual((await response.json()).status, "skipped");
  deepStrictEqual(calls, [`begin:${HOLDER}:${LEASE_SECONDS}`]);
  strictEqual(finishes.length, 0);
  deepStrictEqual(requests, []);
});

Deno.test("polls every symbol with a yahoo_symbol, writes under source yahoo, and releases the lease as ok", async () => {
  const { handler, calls, finishes } = build({
    symbols: [
      { symbol: "NVDA", yahooSymbol: "NVDA" },
      { symbol: "BZ", yahooSymbol: "BZ=F" },
    ],
  });
  const response = await handler(tick());
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  strictEqual(body.targets, 2);
  ok(calls.includes("quote:yahoo:NVDA:100"));
  ok(calls.includes("quote:yahoo:BZ:100"));
  ok(calls.includes("candles:yahoo:NVDA:1m:1"));
  ok(calls.includes("candles:yahoo:NVDA:1D:1"));
  ok(calls.includes("health:success:yahoo"));
  deepStrictEqual(
    { holder: finishes[0]?.holder, outcome: finishes[0]?.outcome, backoff: finishes[0]?.backoff },
    { holder: HOLDER, outcome: "ok", backoff: 0 },
  );
});

Deno.test("backs off for the rate-limit window and reports rate_limited", async () => {
  const { handler, finishes, requests } = build({
    symbols: [
      { symbol: "NVDA", yahooSymbol: "NVDA" },
      { symbol: "BZ", yahooSymbol: "BZ=F" },
    ],
    intraday: async () => {
      throw new YahooRateLimitError("yahoo chart NVDA returned HTTP 429", 429);
    },
  });
  const response = await handler(tick());
  strictEqual((await response.json()).status, "rate_limited");
  strictEqual(finishes[0]?.outcome, "rate_limited");
  strictEqual(finishes[0]?.backoff, RATE_LIMIT_BACKOFF_SECONDS);
  deepStrictEqual(requests, ["intraday:NVDA", "intraday:BZ=F"]);
});

Deno.test("reports degraded when one symbol's request fails but another persists", async () => {
  const { handler, finishes } = build({
    symbols: [
      { symbol: "NVDA", yahooSymbol: "NVDA" },
      { symbol: "BZ", yahooSymbol: "BZ=F" },
    ],
    intraday: async (symbol) => {
      if (symbol === "NVDA") throw new YahooError("yahoo chart NVDA returned HTTP 500", 500);
      return chart();
    },
  });
  strictEqual((await (await handler(tick())).json()).status, "degraded");
  strictEqual(finishes[0]?.outcome, "degraded");
  strictEqual(finishes[0]?.backoff, 0);
});

Deno.test("releases the lease and returns 500 when symbol loading fails", async () => {
  const { handler, finishes } = build({ listSymbolsError: new Error("PostgREST GET returned HTTP 503") });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  strictEqual(finishes.length, 1);
  strictEqual(finishes[0]?.outcome, "error");
  strictEqual(finishes[0]?.backoff, 0);
});

Deno.test("fails the run when no symbol has a usable yahoo_symbol", async () => {
  const { handler, finishes, requests } = build({ symbols: [{ symbol: "SKHY", yahooSymbol: null }] });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  strictEqual(finishes[0]?.outcome, "error");
  deepStrictEqual(requests, []);
});

Deno.test("skips a malformed yahoo_symbol and still polls the valid ones", async () => {
  const logs: string[] = [];
  const fake = fakeStore({
    symbols: [
      { symbol: "BAD", yahooSymbol: "BAD/../x" },
      { symbol: "NVDA", yahooSymbol: "NVDA" },
    ],
  });
  const fakeYahoo = fakeClient();
  const handler = createYahooCollectorHandler({
    cronSecret: SECRET,
    store: fake.store,
    client: fakeYahoo.client,
    now: () => NOW,
    newHolder: () => HOLDER,
    log: (message) => logs.push(message),
  });
  const body = await (await handler(tick())).json();
  strictEqual(body.targets, 1);
  deepStrictEqual(fakeYahoo.requests, ["intraday:NVDA", "daily:NVDA"]);
  ok(logs.some((line) => line.includes("BAD") && line.includes("skipping")));
});

Deno.test("refreshes daily bars at most once per refresh window across ticks on the same instance", async () => {
  const { handler, requests } = build({ symbols: [{ symbol: "NVDA", yahooSymbol: "NVDA" }] });
  await handler(tick());
  await handler(tick());
  strictEqual(requests.filter((r) => r.startsWith("daily:")).length, 1);
  strictEqual(requests.filter((r) => r.startsWith("intraday:")).length, 2);
});

Deno.test("toYahooTargets keeps the valid symbols in order", () => {
  const targets = toYahooTargets(
    [
      { symbol: "A", yahooSymbol: null },
      { symbol: "B", yahooSymbol: "BZ=F" },
      { symbol: "C", yahooSymbol: "^GSPC" },
      { symbol: "D", yahooSymbol: "x y" },
    ],
    () => undefined,
  );
  deepStrictEqual(targets, [
    { symbol: "B", instId: "BZ=F" },
    { symbol: "C", instId: "^GSPC" },
  ]);
});
