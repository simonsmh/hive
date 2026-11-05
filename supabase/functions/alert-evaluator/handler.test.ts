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

const MA_RULE_ID = "44444444-4444-4444-8444-444444444444";
const CLOSE_NOW = Date.parse("2026-11-02T07:00:00.000Z");

function maRule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: MA_RULE_ID,
    name: "HTGD MA5 reclaim",
    symbol: "HTGD",
    source: "sina",
    kind: "ma_cross",
    params: { period: 5, direction: "above", interval: "5m" },
    cooldownSeconds: 1800,
    lastTriggeredAtMs: null,
    ...overrides,
  };
}

/** Five daily closes averaging exactly 46, ascending, last one day before the 5m bars. */
function dailyCloses(): Candle[] {
  return [44, 45, 46, 47, 48].map((close, i) => bar(Date.parse("2026-10-26T00:00:00.000Z") + i * 86_400_000, close));
}

Deno.test("fires ma_cross when the latest 5m bar closes across the 5-day average, fetching the daily series too", async () => {
  const { store, candleRequests, recorded } = fakeStore({
    rules: [maRule()],
    candles: {
      "HTGD|sina|5m": series([45.9, 46.2]),
      "HTGD|sina|1D": dailyCloses(),
    },
  });

  const { status, body } = await run(evaluator(store));

  strictEqual(status, 200);
  strictEqual(body.fired, 1);
  deepStrictEqual(candleRequests, [
    { symbol: "HTGD", source: "sina", interval: "5m", limit: 2 },
    { symbol: "HTGD", source: "sina", interval: "1D", limit: 5 },
  ]);
  deepStrictEqual(recorded[0]?.[0]?.payload, {
    source: "sina",
    symbol: "HTGD",
    rule_id: MA_RULE_ID,
    rule_name: "HTGD MA5 reclaim",
    interval: "5m",
    bar_ts: "2026-10-14T11:59:00.000Z",
    ma: 46,
    last_price: 46.2,
    previous_price: 45.9,
    period: 5,
    close_confirmation: 0,
  });
});

Deno.test("marks a 14:55 Shanghai trigger bar as the close confirmation", async () => {
  const { store, recorded } = fakeStore({
    rules: [maRule()],
    candles: {
      // 14:50 and 14:55 Shanghai on 2026-11-02; the evaluator clock sits at 15:00 so both are fresh.
      // The confirmation average is recalculated with today's close included:
      // (45 + 46 + 47 + 48 + 47) / 5 = 46.6, so the 47.00 close reclaims it.
      "HTGD|sina|5m": [bar(Date.parse("2026-11-02T06:50:00.000Z"), 45.9), bar(Date.parse("2026-11-02T06:55:00.000Z"), 47.0)],
      "HTGD|sina|1D": dailyCloses(),
    },
  });
  const handler = createAlertEvaluatorHandler({ cronSecret: SECRET, store, now: () => CLOSE_NOW, log: () => {} });

  const { body } = await run(handler);

  strictEqual(body.fired, 1);
  strictEqual(recorded[0]?.[0]?.payload.bar_ts, "2026-11-02T06:55:00.000Z");
  strictEqual(recorded[0]?.[0]?.payload.close_confirmation, 1);
  strictEqual(recorded[0]?.[0]?.payload.ma, 46.6);
});

Deno.test("does not confirm the reclaim when the close sits below the recalculated average", async () => {
  const { store, recorded } = fakeStore({
    rules: [maRule()],
    candles: {
      // Same daily closes, but the 14:55 close is 46.20: the recalculated average is
      // (45 + 46 + 47 + 48 + 46.2) / 5 = 46.44, above the close, so there is no reclaim even
      // though 46.20 is above the average through yesterday (46).
      "HTGD|sina|5m": [bar(Date.parse("2026-11-02T06:50:00.000Z"), 45.9), bar(Date.parse("2026-11-02T06:55:00.000Z"), 46.2)],
      "HTGD|sina|1D": dailyCloses(),
    },
  });
  const handler = createAlertEvaluatorHandler({ cronSecret: SECRET, store, now: () => CLOSE_NOW, log: () => {} });

  const { body } = await run(handler);

  strictEqual(body.fired, 0);
  strictEqual(body.skipped.not_fired, 1);
  strictEqual(recorded.length, 0);
});

Deno.test("does not fire ma_cross when the previous bar is already above the average", async () => {
  const { store, recorded } = fakeStore({
    rules: [maRule()],
    candles: {
      "HTGD|sina|5m": series([46.5, 46.2]),
      "HTGD|sina|1D": dailyCloses(),
    },
  });

  const { body } = await run(evaluator(store));

  strictEqual(body.fired, 0);
  strictEqual(body.skipped.not_fired, 1);
  strictEqual(recorded.length, 0);
});

Deno.test("skips ma_cross as no data when fewer than period daily closes exist", async () => {
  const { store, recorded } = fakeStore({
    rules: [maRule()],
    candles: {
      "HTGD|sina|5m": series([45.9, 46.2]),
      "HTGD|sina|1D": dailyCloses().slice(1),
    },
  });

  const { body } = await run(evaluator(store));

  strictEqual(body.fired, 0);
  strictEqual(body.skipped.no_data, 1);
  strictEqual(recorded.length, 0);
});

const RETRACE_RULE_ID = "55555555-5555-4555-8555-555555555555";
// 15m bars ending at the 13:45 UTC bar (21:45 Beijing), so the evaluator clock at 14:00 UTC sees them fresh.
const RETRACE_NOW = Date.parse("2026-11-03T14:00:00.000Z");
const RETRACE_LAST = RETRACE_NOW - 15 * 60_000;

function retraceRule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: RETRACE_RULE_ID,
    name: "XAU 15m turning point 0.3%",
    symbol: "XAU",
    source: "okx",
    kind: "retracement",
    params: { interval: "15m", lookback: 20, minRetracePct: 0.3, side: "both" },
    cooldownSeconds: 1800,
    lastTriggeredAtMs: null,
    ...overrides,
  };
}

/** 15m bars with explicit high/low, newest bar opening at RETRACE_LAST. */
function retraceBars(bars: [number, number, number, number][], lastTs = RETRACE_LAST): Candle[] {
  return bars.map(([open, high, low, close], i) => ({
    ts: lastTs - (bars.length - 1 - i) * 15 * 60_000,
    open,
    high,
    low,
    close,
    volume: 10,
    volCcy: 0,
    confirmed: true,
  }));
}

/** Twenty flat 4000..4010 bars, then `tail`; the last tail bar is judged against a window of exactly 4000..4010. */
function withFlatWindow(tail: [number, number, number, number][]): Candle[] {
  // The tail bar is the one being judged, so 20 flat bars are needed to fill a 20-bar lookback window.
  const flat = Array.from({ length: 20 }, () => [4005, 4010, 4000, 4005] as [number, number, number, number]);
  return retraceBars([...flat, ...tail]);
}

Deno.test("fires a suspected top when the 15m close gives back 0.3% from the window high", async () => {
  const { store, recorded } = fakeStore({
    rules: [retraceRule()],
    // The 20-bar anchor window is 4000..4010. A 3996.6 close is (4010 - 3996.6) / 4010 = 0.3342% below the high,
    // past the 0.3% threshold, while its own 3996.4 low stays out of the window and cannot lower the anchor.
    candles: { "XAU|okx|15m": withFlatWindow([[4005, 4010, 3996.4, 3996.6]]) },
  });
  const handler = createAlertEvaluatorHandler({ cronSecret: SECRET, store, now: () => RETRACE_NOW, log: () => {} });

  const { status, body } = await run(handler);

  strictEqual(status, 200);
  strictEqual(body.fired, 1);
  deepStrictEqual(recorded[0]?.[0], {
    dedup_key: `rule:${RETRACE_RULE_ID}:${RETRACE_LAST}`,
    rule_id: RETRACE_RULE_ID,
    symbol: "XAU",
    kind: "retracement",
    severity: "warning",
    payload: {
      source: "okx",
      symbol: "XAU",
      rule_id: RETRACE_RULE_ID,
      rule_name: "XAU 15m turning point 0.3%",
      interval: "15m",
      bar_ts: "2026-11-03T13:45:00.000Z",
      is_top: 1,
      last_price: 3996.6,
      anchor_price: 4010,
      retrace_pct: 0.3342,
      lookback: 20,
      min_retrace_pct: 0.3,
    },
  });
});

Deno.test("fires a suspected bottom when the 15m close rebounds 0.3% off the window low", async () => {
  const { store, recorded } = fakeStore({
    rules: [retraceRule({ id: "66666666-6666-4666-8666-666666666666", symbol: "CL", name: "CL 15m turning point 0.3%" })],
    // Window low 4000: a 4013.8 close is 0.345% above it, and the bar's own high 4013.8 keeps the retracement off
    // the 4010 window high at 0.095%. The whole bar sits above the earlier bars, so its own low sets nothing.
    candles: { "CL|okx|15m": withFlatWindow([[4011, 4013.8, 4005, 4013.8]]) },
  });
  const handler = createAlertEvaluatorHandler({ cronSecret: SECRET, store, now: () => RETRACE_NOW, log: () => {} });

  const { body } = await run(handler);

  strictEqual(body.fired, 1);
  deepStrictEqual(recorded[0]?.[0]?.payload, {
    source: "okx",
    symbol: "CL",
    rule_id: "66666666-6666-4666-8666-666666666666",
    rule_name: "CL 15m turning point 0.3%",
    interval: "15m",
    bar_ts: "2026-11-03T13:45:00.000Z",
    is_top: 0,
    last_price: 4013.8,
    anchor_price: 4000,
    retrace_pct: 0.345,
    lookback: 20,
    min_retrace_pct: 0.3,
  });
});

Deno.test("does not fire retracement while the close is inside the 0.3% band", async () => {
  const { store, recorded } = fakeStore({
    rules: [retraceRule()],
    // 4008.5 is 0.0374% below the 4010 high and 0.2125% above the 4000 low.
    candles: { "XAU|okx|15m": withFlatWindow([[4005, 4010, 4008, 4008.5]]) },
  });
  const handler = createAlertEvaluatorHandler({ cronSecret: SECRET, store, now: () => RETRACE_NOW, log: () => {} });

  const { body } = await run(handler);

  strictEqual(body.fired, 0);
  strictEqual(body.skipped.not_fired, 1);
  strictEqual(recorded.length, 0);
});

Deno.test("respects the 30 minute cooldown on a fired retracement", async () => {
  const bars = withFlatWindow([[4005, 4010, 3996.4, 3996.6]]);
  const lastTriggeredAtMs = RETRACE_NOW - 29 * 60_000;
  const { store, recorded } = fakeStore({ rules: [retraceRule({ lastTriggeredAtMs })], candles: { "XAU|okx|15m": bars } });
  const handler = createAlertEvaluatorHandler({ cronSecret: SECRET, store, now: () => RETRACE_NOW, log: () => {} });

  const { body } = await run(handler);

  strictEqual(body.fired, 0);
  strictEqual(body.skipped.cooldown, 1);
  strictEqual(recorded.length, 0);

  // The same rule fires again once the 1800s window has passed.
  const later = fakeStore({ rules: [retraceRule({ lastTriggeredAtMs: RETRACE_NOW - 1800_000 })], candles: { "XAU|okx|15m": bars } });
  const { body: after } = await run(
    createAlertEvaluatorHandler({ cronSecret: SECRET, store: later.store, now: () => RETRACE_NOW, log: () => {} }),
  );
  strictEqual(after.fired, 1);
  strictEqual(later.recorded.length, 1);
});
