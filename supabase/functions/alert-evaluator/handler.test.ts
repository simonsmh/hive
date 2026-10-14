import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import {
  type AlertInsert,
  type AlertRuleRow,
  type CandleRequest,
  createAlertEvaluatorHandler,
  type EvaluatorStore,
  type RecordResult,
} from "./handler.ts";

const SECRET = "test-cron-secret";
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const LAST_BAR = NOW - 60_000;
const SNDK_RULE_ID = "11111111-1111-4111-8111-111111111111";
const MU_RULE_ID = "22222222-2222-4222-8222-222222222222";
const CROSS_RULE_ID = "33333333-3333-4333-8333-333333333333";

function bar(ts: number, close: number, volume = 100): Candle {
  return { ts, open: close, high: close, low: close, close, volume, volCcy: 0, confirmed: true };
}

/** Ascending 1m series whose newest bar opens at lastTs. */
function series(closes: number[], lastTs = LAST_BAR): Candle[] {
  return closes.map((close, i) => bar(lastTs - (closes.length - 1 - i) * 60_000, close));
}

/** Flat for ten bars, then the latest bar at `last`: a move of (last - 100) percent. */
function tenBarMove(last: number, lastTs = LAST_BAR): Candle[] {
  return series([...Array.from({ length: 10 }, () => 100), last], lastTs);
}

function rule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: SNDK_RULE_ID,
    name: "SNDK 10m move >=1%",
    symbol: "SNDK",
    source: "okx",
    kind: "pct_move",
    params: { interval: "1m", lookback: 10, minAbsPct: 1 },
    cooldownSeconds: 600,
    lastTriggeredAtMs: null,
    ...overrides,
  };
}

interface FakeOptions {
  rules?: AlertRuleRow[];
  /** Keyed by `${symbol}|${source}|${interval}`, ascending. */
  candles?: Record<string, Candle[]>;
  failCandlesFor?: string;
  listError?: Error;
  recordError?: Error;
  recordResult?: RecordResult;
}

function fakeStore(options: FakeOptions = {}) {
  const candleRequests: CandleRequest[] = [];
  const recorded: AlertInsert[][] = [];
  const store: EvaluatorStore = {
    async listEnabledRules() {
      if (options.listError) throw options.listError;
      return options.rules ?? [];
    },
    async confirmedCandles(request) {
      candleRequests.push(request);
      const key = `${request.symbol}|${request.source}|${request.interval}`;
      if (key === options.failCandlesFor) throw new Error("candles unavailable");
      return (options.candles?.[key] ?? []).slice(-request.limit);
    },
    async recordAlerts(alerts) {
      if (options.recordError) throw options.recordError;
      recorded.push(alerts);
      return options.recordResult ?? { inserted: alerts.length, duplicates: 0 };
    },
  };
  return { store, candleRequests, recorded };
}

function evaluator(store: EvaluatorStore) {
  return createAlertEvaluatorHandler({ cronSecret: SECRET, store, now: () => NOW, log: () => {} });
}

function post(authorization: string | null = `Bearer ${SECRET}`, method = "POST"): Request {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return new Request("https://functions.test/alert-evaluator", { method, headers });
}

async function run(handler: (request: Request) => Promise<Response>, request = post()) {
  const response = await handler(request);
  return { status: response.status, body: await response.json() };
}

Deno.test("rejects non-POST requests, bad bearer tokens and a missing cron secret", async () => {
  const { store } = fakeStore();
  strictEqual((await evaluator(store)(post(`Bearer ${SECRET}`, "GET"))).status, 405);
  strictEqual((await evaluator(store)(post(null))).status, 401);
  strictEqual((await evaluator(store)(post("Bearer wrong"))).status, 401);
  const unconfigured = createAlertEvaluatorHandler({ cronSecret: undefined, store, now: () => NOW, log: () => {} });
  strictEqual((await unconfigured(post())).status, 500);
});

Deno.test("fires a pct_move alert with its payload, severity and per-bar dedup key", async () => {
  const { store, candleRequests, recorded } = fakeStore({
    rules: [rule()],
    candles: { "SNDK|okx|1m": tenBarMove(102) },
  });

  const { status, body } = await run(evaluator(store));

  strictEqual(status, 200);
  strictEqual(body.status, "ok");
  strictEqual(body.fired, 1);
  deepStrictEqual(candleRequests, [{ symbol: "SNDK", source: "okx", interval: "1m", limit: 11 }]);
  strictEqual(recorded.length, 1);
  deepStrictEqual(recorded[0], [
    {
      dedup_key: `rule:${SNDK_RULE_ID}:${LAST_BAR}`,
      rule_id: SNDK_RULE_ID,
      symbol: "SNDK",
      kind: "pct_move",
      severity: "warning",
      payload: {
        source: "okx",
        symbol: "SNDK",
        rule_id: SNDK_RULE_ID,
        rule_name: "SNDK 10m move >=1%",
        interval: "1m",
        bar_ts: "2026-10-14T11:59:00.000Z",
        last_price: 102,
        earlier_price: 100,
        pct: 2,
        lookback: 10,
        min_abs_pct: 1,
      },
    },
  ]);
});

Deno.test("fires on a drop of the same size and reports a negative pct", async () => {
  const { store, recorded } = fakeStore({ rules: [rule()], candles: { "SNDK|okx|1m": tenBarMove(98) } });

  await run(evaluator(store));

  strictEqual(recorded[0]?.[0]?.payload.pct, -2);
});

Deno.test("does not record anything when the move is below the threshold", async () => {
  const { store, recorded } = fakeStore({ rules: [rule()], candles: { "SNDK|okx|1m": tenBarMove(100.9) } });

  const { body } = await run(evaluator(store));

  strictEqual(body.fired, 0);
  strictEqual(body.skipped.not_fired, 1);
  strictEqual(recorded.length, 0);
});

Deno.test("respects the cooldown until cooldown_seconds has passed since the last alert", async () => {
  const candles = { "SNDK|okx|1m": tenBarMove(102) };

  const recent = fakeStore({ rules: [rule({ lastTriggeredAtMs: NOW - 300_000 })], candles });
  const cooled = await run(evaluator(recent.store));
  strictEqual(cooled.body.skipped.cooldown, 1);
  strictEqual(recent.recorded.length, 0);

  const expired = fakeStore({ rules: [rule({ lastTriggeredAtMs: NOW - 601_000 })], candles });
  const fired = await run(evaluator(expired.store));
  strictEqual(fired.body.fired, 1);
  strictEqual(expired.recorded.length, 1);
});

Deno.test("skips a series whose newest confirmed bar is stale", async () => {
  const stale = tenBarMove(102, NOW - 10 * 60_000);
  const { store, recorded } = fakeStore({ rules: [rule()], candles: { "SNDK|okx|1m": stale } });

  const { body } = await run(evaluator(store));

  strictEqual(body.skipped.stale, 1);
  strictEqual(recorded.length, 0);
});

Deno.test("does not fire pct_move with fewer bars than lookback + 1", async () => {
  const { store, recorded } = fakeStore({ rules: [rule()], candles: { "SNDK|okx|1m": series([100, 102]) } });

  const { body } = await run(evaluator(store));

  strictEqual(body.skipped.not_fired, 1);
  strictEqual(recorded.length, 0);
});

Deno.test("skips a rule with no candles without failing the run", async () => {
  const { store, recorded } = fakeStore({ rules: [rule()], candles: {} });

  const { status, body } = await run(evaluator(store));

  strictEqual(status, 200);
  strictEqual(body.skipped.no_data, 1);
  strictEqual(recorded.length, 0);
});

Deno.test("fetches each series once, with the largest window any rule on it needs", async () => {
  const { store, candleRequests, recorded } = fakeStore({
    rules: [
      rule(),
      rule({ id: CROSS_RULE_ID, name: "SNDK price cross", kind: "price_cross", params: { level: 150, direction: "above" } }),
    ],
    candles: { "SNDK|okx|1m": tenBarMove(102) },
  });

  const { body } = await run(evaluator(store));

  deepStrictEqual(candleRequests, [{ symbol: "SNDK", source: "okx", interval: "1m", limit: 11 }]);
  strictEqual(body.fired, 1);
  strictEqual(recorded[0]?.[0]?.kind, "pct_move");
});

Deno.test("evaluates price_cross on the two latest 1m closes", async () => {
  const { store, recorded } = fakeStore({
    rules: [rule({ kind: "price_cross", params: { level: 100, direction: "above" } })],
    candles: { "SNDK|okx|1m": series([99, 101]) },
  });

  await run(evaluator(store));

  deepStrictEqual(recorded[0]?.[0]?.payload, {
    source: "okx",
    symbol: "SNDK",
    rule_id: SNDK_RULE_ID,
    rule_name: "SNDK 10m move >=1%",
    interval: "1m",
    bar_ts: "2026-10-14T11:59:00.000Z",
    last_price: 101,
    previous_price: 99,
    level: 100,
  });
});

Deno.test("skips invalid rule params without blocking the other rules", async () => {
  const { store, recorded } = fakeStore({
    rules: [
      rule({ id: MU_RULE_ID, name: "bad", params: { interval: "1m", lookback: 0, minAbsPct: 1 } }),
      rule(),
    ],
    candles: { "SNDK|okx|1m": tenBarMove(102) },
  });

  const { body } = await run(evaluator(store));

  strictEqual(body.invalid, 1);
  strictEqual(body.fired, 1);
  strictEqual(recorded[0]?.[0]?.rule_id, SNDK_RULE_ID);
});

Deno.test("reports a failed series as partial and still evaluates the other symbols", async () => {
  const { store, recorded } = fakeStore({
    rules: [rule(), rule({ id: MU_RULE_ID, name: "MU 10m move >=1%", symbol: "MU" })],
    candles: { "MU|okx|1m": tenBarMove(102) },
    failCandlesFor: "SNDK|okx|1m",
  });

  const { status, body } = await run(evaluator(store));

  strictEqual(status, 200);
  strictEqual(body.status, "partial");
  strictEqual(body.skipped.candle_failed, 1);
  strictEqual(body.fired, 1);
  strictEqual(recorded[0]?.[0]?.symbol, "MU");
  ok(body.failures[0].includes("SNDK|okx|1m"));
});

Deno.test("returns 500 when the rule read fails", async () => {
  const { store } = fakeStore({ listError: new Error("PostgREST GET returned HTTP 503") });

  const { status, body } = await run(evaluator(store));

  strictEqual(status, 500);
  ok(String(body.error).includes("alert_rules read failed"));
});

Deno.test("returns 500 when the alert write fails so the failure shows in pg_net responses", async () => {
  const { store } = fakeStore({
    rules: [rule()],
    candles: { "SNDK|okx|1m": tenBarMove(102) },
    recordError: new Error("PostgREST POST returned HTTP 500"),
  });

  const { status, body } = await run(evaluator(store));

  strictEqual(status, 500);
  ok(String(body.error).includes("alerts write failed"));
});

Deno.test("reports rows the database skipped as duplicates of an earlier bar", async () => {
  const { store } = fakeStore({
    rules: [rule()],
    candles: { "SNDK|okx|1m": tenBarMove(102) },
    recordResult: { inserted: 0, duplicates: 1 },
  });

  const { body } = await run(evaluator(store));

  strictEqual(body.fired, 1);
  strictEqual(body.inserted, 0);
  strictEqual(body.duplicates, 1);
});
