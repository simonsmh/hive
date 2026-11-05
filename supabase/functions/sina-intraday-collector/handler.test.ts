import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import { SinaRateLimitError, type SinaIntraday, type SinaIntradayData } from "./core/sina.ts";
import {
  createSinaIntradayCollectorHandler,
  LEASE_SECONDS,
  RATE_LIMIT_BACKOFF_SECONDS,
  toSinaIntradayTargets,
  type SinaIntradayCollectorStore,
  type SinaIntradaySymbolRecord,
} from "./handler.ts";

const SECRET = "test-cron-secret";
const HOLDER = "holder-1";
const NOW = 1_000_000;

const candle: Candle = { ts: 1_791_900_780_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 0, confirmed: true };

function intraday(candles: Candle[] = [candle]): SinaIntraday {
  return { candles, rejected: 0 };
}

interface FakeStoreOptions {
  leaseGranted?: boolean;
  symbols?: SinaIntradaySymbolRecord[];
  listSymbolsError?: Error;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const calls: string[] = [];
  const finishes: Array<{ holder: string; outcome: string; backoff: number; summary: Record<string, unknown> }> = [];
  const store: SinaIntradayCollectorStore = {
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
      return options.symbols ?? [{ symbol: "SH513310", thsCode: "513310.SH" }];
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
  intraday?: (sinaCode: string) => Promise<SinaIntraday>;
}

function fakeClient(options: FakeClientOptions = {}) {
  const requests: string[] = [];
  const client: SinaIntradayData = {
    async getIntraday(sinaCode) {
      requests.push(sinaCode);
      return options.intraday ? options.intraday(sinaCode) : intraday();
    },
  };
  return { client, requests };
}

function tick(method = "POST", secret: string | null = SECRET): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return new Request("https://functions.test/sina-intraday-collector", { method, headers });
}

function build(options: FakeStoreOptions & FakeClientOptions & { collectorSecret?: string | undefined } = {}) {
  const fake = fakeStore(options);
  const fakeSina = fakeClient(options);
  const handler = createSinaIntradayCollectorHandler({
    cronSecret: "collectorSecret" in options ? options.collectorSecret : SECRET,
    store: fake.store,
    client: fakeSina.client,
    now: () => NOW,
    newHolder: () => HOLDER,
    log: () => undefined,
  });
  return { handler, ...fake, requests: fakeSina.requests };
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

Deno.test("rejects missing or wrong bearer token without starting a run", async () => {
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

Deno.test("polls only the whitelisted symbol, writes only 5m candles under source sina, and releases the lease as ok", async () => {
  const { handler, calls, finishes } = build({
    symbols: [
      { symbol: "SH000001", thsCode: "000001.SH" },
      { symbol: "SH513310", thsCode: "513310.SH" },
      { symbol: "BTC", thsCode: null },
    ],
  });
  const response = await handler(tick());
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  strictEqual(body.targets, 1);
  ok(calls.includes("candles:sina:SH513310:5m:1"));
  ok(!calls.some((call) => call.includes(":SH000001:")));
  ok(!calls.some((call) => call.startsWith("quote:")));
  ok(calls.includes("health:success:sina"));
  deepStrictEqual(
    { holder: finishes[0]?.holder, outcome: finishes[0]?.outcome, backoff: finishes[0]?.backoff },
    { holder: HOLDER, outcome: "ok", backoff: 0 },
  );
});

Deno.test("backs off for the rate-limit window and reports rate_limited", async () => {
  const { handler, finishes, requests } = build({
    symbols: [{ symbol: "SH513310", thsCode: "513310.SH" }],
    intraday: async () => {
      throw new SinaRateLimitError("sina k-line sh513310 returned HTTP 403", 403);
    },
  });
  const response = await handler(tick());
  strictEqual((await response.json()).status, "rate_limited");
  strictEqual(finishes[0]?.outcome, "rate_limited");
  strictEqual(finishes[0]?.backoff, RATE_LIMIT_BACKOFF_SECONDS);
  deepStrictEqual(requests, ["sh513310"]);
});

Deno.test("releases the lease and returns 500 when symbol loading fails", async () => {
  const { handler, finishes } = build({ listSymbolsError: new Error("PostgREST GET returned HTTP 503") });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  strictEqual(finishes.length, 1);
  strictEqual(finishes[0]?.outcome, "error");
  strictEqual(finishes[0]?.backoff, 0);
});

Deno.test("fails the run when no whitelisted symbol has a mappable ths_code", async () => {
  const { handler, finishes, requests } = build({ symbols: [{ symbol: "SH000001", thsCode: "000001.SH" }] });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  strictEqual(finishes[0]?.outcome, "error");
  deepStrictEqual(requests, []);
});

Deno.test("toSinaIntradayTargets keeps only the whitelist, skips null ths_code silently and logs unmappable codes", () => {
  const logs: string[] = [];
  const targets = toSinaIntradayTargets(
    [
      { symbol: "BTC", thsCode: null },
      { symbol: "BAD", thsCode: "600487.TI" },
      { symbol: "SH000001", thsCode: "000001.SH" },
      { symbol: "SH513310", thsCode: "513310.SH" },
    ],
    (message) => logs.push(message),
  );
  deepStrictEqual(targets, [{ symbol: "SH513310", sinaCode: "sh513310" }]);
  ok(logs.some((line) => line.includes("BAD") && line.includes("skipping")));
  ok(!logs.some((line) => line.includes("BTC")));
  ok(logs.some((line) => line.includes("outside the intraday whitelist")));
});

Deno.test("polls the HTGD whitelist addition alongside SH513310", async () => {
  const { handler, calls, requests } = build({
    symbols: [
      { symbol: "SH513310", thsCode: "513310.SH" },
      { symbol: "HTGD", thsCode: "600487.SH" },
    ],
  });
  const response = await handler(tick());
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  strictEqual(body.targets, 2);
  ok(calls.includes("candles:sina:HTGD:5m:1"));
  ok(calls.includes("candles:sina:SH513310:5m:1"));
  deepStrictEqual(requests, ["sh513310", "sh600487"]);
});

Deno.test("polls the SZ159915 whitelist addition alongside SH513310", async () => {
  const { handler, calls, requests } = build({
    symbols: [
      { symbol: "SH513310", thsCode: "513310.SH" },
      { symbol: "SZ159915", thsCode: "159915.SZ" },
    ],
  });
  const response = await handler(tick());
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  strictEqual(body.targets, 2);
  ok(calls.includes("candles:sina:SZ159915:5m:1"));
  ok(calls.includes("candles:sina:SH513310:5m:1"));
  deepStrictEqual(requests, ["sh513310", "sz159915"]);
});

Deno.test("toSinaIntradayTargets maps SZ159915 to sz159915", () => {
  const targets = toSinaIntradayTargets([{ symbol: "SZ159915", thsCode: "159915.SZ" }], () => undefined);
  deepStrictEqual(targets, [{ symbol: "SZ159915", sinaCode: "sz159915" }]);
});

Deno.test("toSinaIntradayTargets maps HTGD to sh600487", () => {
  const targets = toSinaIntradayTargets([{ symbol: "HTGD", thsCode: "600487.SH" }], () => undefined);
  deepStrictEqual(targets, [{ symbol: "HTGD", sinaCode: "sh600487" }]);
});
