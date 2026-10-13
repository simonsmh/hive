import { deepStrictEqual, strictEqual, ok } from "node:assert/strict";
import { OkxRateLimitError, type OkxInstrument, type ParsedCandles } from "./core/okx.ts";
import type { Candle } from "./core/types.ts";
import { createCollectorHandler, LEASE_SECONDS, RATE_LIMIT_BACKOFF_SECONDS } from "./handler.ts";
import type { EdgeCollectorStore } from "./store.ts";

const SECRET = "test-collector-secret";
const HOLDER = "holder-1";
const NOW = 1_000_000;

const candle: Candle = { ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 15, confirmed: true };

const instruments: OkxInstrument[] = [{ instId: "ETH-USDT-SWAP", instType: "SWAP", state: "live" }];

interface FakeOptions {
  leaseGranted?: boolean;
  symbols?: { symbol: string; okxInstId: string | null }[];
  listSymbolsError?: Error;
  tickerError?: Error;
}

function fakeStore(options: FakeOptions = {}) {
  const calls: string[] = [];
  const finishes: Array<{ holder: string; outcome: string; backoff: number; summary: Record<string, unknown> }> = [];
  const store: EdgeCollectorStore = {
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
      return options.symbols ?? [{ symbol: "BTC", okxInstId: "BTC-USDT-SWAP" }];
    },
    async setInstId(symbol, instId) {
      calls.push(`setInstId:${symbol}:${instId}`);
    },
    async upsertQuote(symbol, _source, quote) {
      calls.push(`quote:${symbol}:${quote.price}`);
    },
    async upsertCandles(symbol, _source, interval, rows) {
      calls.push(`candles:${symbol}:${interval}:${rows.length}`);
      return rows.length;
    },
    async recordSourceSuccess() {
      calls.push("health:success");
    },
    async recordSourceFailure(_source, error) {
      calls.push(`health:failure:${error}`);
    },
  };
  return { store, calls, finishes };
}

function fakeOkx(options: { tickerError?: Error; instrumentCalls?: { count: number } } = {}) {
  return {
    async getInstruments() {
      if (options.instrumentCalls) options.instrumentCalls.count += 1;
      return instruments;
    },
    async getTicker(instId: string) {
      if (options.tickerError) throw options.tickerError;
      return { instId, last: 100, ts: 1000 };
    },
    async getCandles(): Promise<ParsedCandles> {
      return { candles: [candle], rejected: 0 };
    },
  };
}

function tick(method = "POST", secret: string | null = SECRET): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return new Request("https://functions.test/okx-collector", { method, headers });
}

function build(options: FakeOptions & { okx?: ReturnType<typeof fakeOkx>; collectorSecret?: string | undefined } = {}) {
  const fake = fakeStore(options);
  const handler = createCollectorHandler({
    collectorSecret: "collectorSecret" in options ? options.collectorSecret : SECRET,
    store: fake.store,
    okx: options.okx ?? fakeOkx({ tickerError: options.tickerError }),
    now: () => NOW,
    newHolder: () => HOLDER,
    log: () => undefined,
  });
  return { handler, ...fake };
}

Deno.test("rejects non-POST requests before touching the store", async () => {
  const { handler, calls } = build();
  const response = await handler(tick("GET"));
  strictEqual(response.status, 405);
  strictEqual(response.headers.get("allow"), "POST");
  deepStrictEqual(calls, []);
});

Deno.test("fails closed when the collector secret is not configured", async () => {
  const { handler, calls } = build({ collectorSecret: undefined });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  deepStrictEqual(calls, []);
});

Deno.test("rejects missing or wrong bearer tokens without starting a run", async () => {
  const { handler, calls } = build();
  strictEqual((await handler(tick("POST", null))).status, 401);
  strictEqual((await handler(tick("POST", "wrong"))).status, 401);
  deepStrictEqual(calls, []);
});

Deno.test("skips the tick when another run holds the lease", async () => {
  const { handler, calls, finishes } = build({ leaseGranted: false });
  const response = await handler(tick());
  strictEqual(response.status, 200);
  strictEqual((await response.json()).status, "skipped");
  deepStrictEqual(calls, [`begin:${HOLDER}:${LEASE_SECONDS}`]);
  strictEqual(finishes.length, 0);
});

Deno.test("polls every enabled symbol, resolves missing ids, and releases the lease as ok", async () => {
  const instrumentCalls = { count: 0 };
  const { handler, calls, finishes } = build({
    symbols: [
      { symbol: "BTC", okxInstId: "BTC-USDT-SWAP" },
      { symbol: "ETH", okxInstId: null },
    ],
    okx: fakeOkx({ instrumentCalls }),
  });
  const response = await handler(tick());
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  strictEqual(body.targets, 2);
  strictEqual(instrumentCalls.count, 1);
  ok(calls.includes("setInstId:ETH:ETH-USDT-SWAP"));
  ok(calls.includes("quote:BTC:100"));
  ok(calls.includes("quote:ETH:100"));
  ok(calls.includes("health:success"));
  strictEqual(finishes.length, 1);
  deepStrictEqual(
    { holder: finishes[0]?.holder, outcome: finishes[0]?.outcome, backoff: finishes[0]?.backoff },
    { holder: HOLDER, outcome: "ok", backoff: 0 },
  );
});

Deno.test("backs off for the rate-limit window and reports rate_limited", async () => {
  const { handler, finishes } = build({
    tickerError: new OkxRateLimitError("OKX /ticker returned HTTP 429", 429),
  });
  const response = await handler(tick());
  strictEqual((await response.json()).status, "rate_limited");
  strictEqual(finishes[0]?.outcome, "rate_limited");
  strictEqual(finishes[0]?.backoff, RATE_LIMIT_BACKOFF_SECONDS);
});

Deno.test("reports degraded when some OKX requests fail but others persist", async () => {
  const okx = fakeOkx();
  const flaky = {
    ...okx,
    async getTicker(instId: string) {
      if (instId === "ETH-USDT-SWAP") throw new Error("OKX /ticker returned HTTP 500");
      return okx.getTicker(instId);
    },
  };
  const { handler, finishes } = build({
    symbols: [
      { symbol: "BTC", okxInstId: "BTC-USDT-SWAP" },
      { symbol: "ETH", okxInstId: "ETH-USDT-SWAP" },
    ],
    okx: flaky,
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

Deno.test("fails the run when no symbol resolves to a live instrument", async () => {
  const { handler, finishes } = build({ symbols: [{ symbol: "NOPE", okxInstId: null }] });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  strictEqual(finishes[0]?.outcome, "error");
});

Deno.test("caches the instrument list between ticks", async () => {
  const instrumentCalls = { count: 0 };
  const okx = fakeOkx({ instrumentCalls });
  const handler = createCollectorHandler({
    collectorSecret: SECRET,
    store: fakeStore({ symbols: [{ symbol: "ETH", okxInstId: null }] }).store,
    okx,
    now: () => NOW,
    newHolder: () => HOLDER,
    log: () => undefined,
  });
  await handler(tick());
  await handler(tick());
  strictEqual(instrumentCalls.count, 1);
});
