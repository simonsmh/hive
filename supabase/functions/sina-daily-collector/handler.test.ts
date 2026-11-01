import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import { SinaRateLimitError, type SinaDaily, type SinaMarketData } from "./core/sina.ts";
import {
  createSinaDailyCollectorHandler,
  LEASE_SECONDS,
  RATE_LIMIT_BACKOFF_SECONDS,
  toSinaTargets,
  type SinaCollectorStore,
  type SinaSymbolRecord,
} from "./handler.ts";

const SECRET = "test-cron-secret";
const HOLDER = "holder-1";
const NOW = 1_000_000;

const candle: Candle = { ts: 1_791_900_780_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 0, confirmed: true };

function daily(candles: Candle[] = [candle]): SinaDaily {
  return { candles, rejected: 0 };
}

interface FakeStoreOptions {
  leaseGranted?: boolean;
  symbols?: SinaSymbolRecord[];
  listSymbolsError?: Error;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const calls: string[] = [];
  const finishes: Array<{ holder: string; outcome: string; backoff: number; summary: Record<string, unknown> }> = [];
  const store: SinaCollectorStore = {
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
      return options.symbols ?? [{ symbol: "HTGD", thsCode: "600487.SH" }];
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
  daily?: (sinaCode: string) => Promise<SinaDaily>;
}

function fakeClient(options: FakeClientOptions = {}) {
  const requests: string[] = [];
  const client: SinaMarketData = {
    async getDaily(sinaCode) {
      requests.push(sinaCode);
      return options.daily ? options.daily(sinaCode) : daily();
    },
  };
  return { client, requests };
}

function tick(method = "POST", secret: string | null = SECRET): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return new Request("https://functions.test/sina-daily-collector", { method, headers });
}

function build(options: FakeStoreOptions & FakeClientOptions & { collectorSecret?: string | undefined } = {}) {
  const fake = fakeStore(options);
  const fakeSina = fakeClient(options);
  const handler = createSinaDailyCollectorHandler({
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

Deno.test("polls every mappable symbol, writes only 1D candles under source sina, and releases the lease as ok", async () => {
  const { handler, calls, finishes } = build({
    symbols: [
      { symbol: "HTGD", thsCode: "600487.SH" },
      { symbol: "SH000001", thsCode: "000001.SH" },
      { symbol: "BTC", thsCode: null },
    ],
  });
  const response = await handler(tick());
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  strictEqual(body.targets, 2);
  ok(calls.includes("candles:sina:HTGD:1D:1"));
  ok(calls.includes("candles:sina:SH000001:1D:1"));
  ok(!calls.some((call) => call.startsWith("quote:")));
  ok(calls.includes("health:success:sina"));
  deepStrictEqual(
    { holder: finishes[0]?.holder, outcome: finishes[0]?.outcome, backoff: finishes[0]?.backoff },
    { holder: HOLDER, outcome: "ok", backoff: 0 },
  );
});

Deno.test("backs off for the rate-limit window and reports rate_limited", async () => {
  const { handler, finishes, requests } = build({
    symbols: [
      { symbol: "HTGD", thsCode: "600487.SH" },
      { symbol: "DML", thsCode: "001309.SZ" },
    ],
    daily: async () => {
      throw new SinaRateLimitError("sina k-line sh600487 returned HTTP 403", 403);
    },
  });
  const response = await handler(tick());
  strictEqual((await response.json()).status, "rate_limited");
  strictEqual(finishes[0]?.outcome, "rate_limited");
  strictEqual(finishes[0]?.backoff, RATE_LIMIT_BACKOFF_SECONDS);
  // Concurrency 2 starts both lanes before either sees the rate-limit flag;
  // the flag stops targets that have not started yet, not in-flight lanes.
  deepStrictEqual(requests, ["sh600487", "sz001309"]);
});

Deno.test("reports degraded when one symbol's request fails but another persists", async () => {
  const { handler, finishes } = build({
    daily: async (sinaCode) => {
      if (sinaCode === "sh600487") throw new Error("sina k-line sh600487 returned HTTP 500");
      return daily();
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

Deno.test("fails the run when no symbol has a mappable ths_code", async () => {
  const { handler, finishes, requests } = build({ symbols: [{ symbol: "BTC", thsCode: null }] });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  strictEqual(finishes[0]?.outcome, "error");
  deepStrictEqual(requests, []);
});

Deno.test("toSinaTargets skips null ths_code silently and logs unmappable codes", () => {
  const logs: string[] = [];
  const targets = toSinaTargets(
    [
      { symbol: "BTC", thsCode: null },
      { symbol: "BAD", thsCode: "600487.TI" },
      { symbol: "HTGD", thsCode: "600487.SH" },
      { symbol: "DML", thsCode: "001309.SZ" },
      { symbol: "SH000001", thsCode: "000001.SH" },
    ],
    (message) => logs.push(message),
  );
  deepStrictEqual(targets, [
    { symbol: "HTGD", sinaCode: "sh600487" },
    { symbol: "DML", sinaCode: "sz001309" },
    { symbol: "SH000001", sinaCode: "sh000001" },
  ]);
  ok(logs.some((line) => line.includes("BAD") && line.includes("skipping")));
  ok(!logs.some((line) => line.includes("BTC")));
});
