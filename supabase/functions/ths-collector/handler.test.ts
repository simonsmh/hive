import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { ThsError, type ThsMarketData, type ThsSnapshot } from "./core/ths.ts";
import { calendarStatusFor, createThsCollectorHandler, LEASE_SECONDS, RATE_LIMIT_BACKOFF_SECONDS } from "./handler.ts";
import type { ThsTarget } from "./core/ths-cycle.ts";
import type { ThsCollectorStore } from "./handler.ts";

const SECRET = "test-collector-secret";
const API_KEY = "test-hithink-key";
const HOLDER = "holder-1";
const WEDNESDAY_10_00_BJ = Date.parse("2026-10-14T02:00:00Z");
const WEDNESDAY_09_20_BJ = Date.parse("2026-10-14T01:20:00Z");
const WEDNESDAY_15_00_BJ = Date.parse("2026-10-14T07:00:00Z");
const WEDNESDAY_18_00_BJ = Date.parse("2026-10-14T10:00:00Z");
const SATURDAY_10_00_BJ = Date.parse("2026-10-17T02:00:00Z");
const TODAY = "2026-10-14";
const TRADING_DAYS = new Set([TODAY, "2026-10-13", "2026-10-12"]);

const TARGETS: ThsTarget[] = [
  { symbol: "SH000001", thscode: "000001.SH", kind: "index", auction: false },
  { symbol: "MOUTAI", thscode: "600519.SH", kind: "stock", auction: true },
];

function snapshotOf(items: Record<string, unknown>[], total: number | null = null): ThsSnapshot {
  return { timestamp: WEDNESDAY_10_00_BJ, total, items };
}

interface FakeClientOptions {
  errors?: Partial<Record<keyof ThsMarketData, Error>>;
}

function fakeClient(options: FakeClientOptions = {}) {
  const calls: string[] = [];
  const respond = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    const error = options.errors?.[name as keyof ThsMarketData];
    return error ? Promise.reject(error) : Promise.resolve(value);
  };
  const client: ThsMarketData & { calls: string[] } = {
    calls,
    indexCatalog: () => respond("indexCatalog", { item: [] }),
    indexConstituents: () => respond("indexConstituents", { item: [] }),
    indexSnapshot: () => respond("indexSnapshot", snapshotOf([{ thscode: "000001.SH", last_price: 3200 }])),
    stockSnapshot: () => respond("stockSnapshot", snapshotOf([{ thscode: "600519.SH", last_price: 1500 }])),
    marketSnapshotPage: () =>
      respond(
        "marketSnapshotPage",
        snapshotOf(
          [
            { thscode: "600000.SH", price_change_ratio_pct: 1.2 },
            { thscode: "000001.SZ", price_change_ratio_pct: -0.5 },
          ],
          2,
        ),
      ),
    auctionSnapshot: (codes, stage) => respond(`auctionSnapshot:${stage}:${codes.join(",")}`, { item: [] }),
    auctionBenchmark: () => respond("auctionBenchmark", { item: [] }),
    limitPool: (name) => respond(`limitPool:${name}`, { timestamp: WEDNESDAY_10_00_BJ, item: [] }),
    limitUpLadder: () => respond("limitUpLadder", { item: [] }),
    hotStock: (period) => respond(`hotStock:${period}`, { item: [] }),
    skyrocket: (period) => respond(`skyrocket:${period}`, { item: [] }),
    anomalyList: () => respond("anomalyList", { item: [] }),
    dragonTiger: () => respond("dragonTiger", { item: [] }),
    tradingDays: () => respond("tradingDays", TRADING_DAYS),
  };
  return client;
}

interface FakeStoreOptions {
  enabled?: boolean;
  enabledError?: Error;
  leaseGranted?: boolean;
  targets?: ThsTarget[];
  existingKinds?: string[];
  healthError?: Error;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const calls: string[] = [];
  const quotes: Array<{ symbol: string; price: number; ts: number }> = [];
  const snapshots: Array<{ date: string; kind: string; payload: Record<string, unknown> }> = [];
  const finishes: Array<{ holder: string; outcome: string; backoff: number; summary: Record<string, unknown> }> = [];
  const store: ThsCollectorStore = {
    async isSourceEnabled() {
      calls.push("enabled");
      if (options.enabledError) throw options.enabledError;
      return options.enabled ?? true;
    },
    async listTargets() {
      calls.push("targets");
      return options.targets ?? TARGETS;
    },
    async beginRun(holder, leaseSeconds) {
      calls.push(`begin:${holder}:${leaseSeconds}`);
      return options.leaseGranted ?? true;
    },
    async finishRun(holder, outcome, backoff, summary) {
      calls.push(`finish:${outcome}`);
      finishes.push({ holder, outcome, backoff, summary });
    },
    async upsertQuote(symbol, _source, quote) {
      quotes.push({ symbol, price: quote.price, ts: quote.ts });
    },
    async upsertDailySnapshot(date, kind, payload) {
      snapshots.push({ date, kind, payload });
    },
    async readDailySnapshot(date, kind) {
      return snapshots.find((row) => row.date === date && row.kind === kind)?.payload ?? null;
    },
    async snapshotExists(date, kind) {
      if (options.existingKinds?.includes(kind)) return true;
      return snapshots.some((row) => row.date === date && row.kind === kind);
    },
    async recordSourceSuccess() {
      calls.push("health:success");
      if (options.healthError) throw options.healthError;
    },
    async recordSourceFailure(_source, error) {
      calls.push(`health:failure:${error}`);
    },
  };
  return { store, calls, quotes, snapshots, finishes };
}

interface BuildOptions extends FakeStoreOptions {
  client?: ReturnType<typeof fakeClient>;
  cronSecret?: string | undefined;
  apiKey?: string | undefined;
  now?: number;
}

function build(options: BuildOptions = {}) {
  const fake = fakeStore(options);
  const client = options.client ?? fakeClient();
  const now = options.now ?? WEDNESDAY_10_00_BJ;
  const handler = createThsCollectorHandler({
    cronSecret: "cronSecret" in options ? options.cronSecret : SECRET,
    apiKey: "apiKey" in options ? options.apiKey : API_KEY,
    store: fake.store,
    client,
    now: () => now,
    newHolder: () => HOLDER,
    log: () => undefined,
  });
  return { handler, client, ...fake };
}

function tick(method = "POST", secret: string | null = SECRET): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return new Request("https://functions.test/ths-collector", { method, headers });
}

Deno.test("rejects non-POST requests before touching the store", async () => {
  const { handler, calls } = build();
  const response = await handler(tick("GET"));
  strictEqual(response.status, 405);
  strictEqual(response.headers.get("allow"), "POST");
  deepStrictEqual(calls, []);
});

Deno.test("fails closed when the collector secret is not configured", async () => {
  const { handler, calls } = build({ cronSecret: undefined });
  strictEqual((await handler(tick())).status, 500);
  deepStrictEqual(calls, []);
});

Deno.test("rejects missing or wrong bearer tokens without starting a run", async () => {
  const { handler, calls, client } = build();
  strictEqual((await handler(tick("POST", null))).status, 401);
  strictEqual((await handler(tick("POST", "wrong"))).status, 401);
  deepStrictEqual(calls, []);
  deepStrictEqual(client.calls, []);
});

Deno.test("reports a missing HiThink key as a configuration error and never calls the store", async () => {
  const { handler, calls } = build({ apiKey: undefined });
  const response = await handler(tick());
  strictEqual(response.status, 500);
  ok(((await response.json()) as { error: string }).error.includes("HITHINK_FINANCE_API_KEY"));
  deepStrictEqual(calls, []);
});

Deno.test("skips ticks outside the weekday session window without polling", async () => {
  const outsideHours = build({ now: WEDNESDAY_18_00_BJ });
  const outsideHoursBody = await (await outsideHours.handler(tick())).json();
  strictEqual(outsideHoursBody.status, "skipped");
  deepStrictEqual(outsideHours.calls, []);
  deepStrictEqual(outsideHours.client.calls, []);

  const weekend = build({ now: SATURDAY_10_00_BJ });
  strictEqual((await (await weekend.handler(tick())).json()).status, "skipped");
  deepStrictEqual(weekend.client.calls, []);
});

Deno.test("skips the tick when the source switch is off", async () => {
  const { handler, calls, client } = build({ enabled: false });
  const response = await handler(tick());
  strictEqual((await response.json()).status, "skipped");
  deepStrictEqual(calls, ["enabled"]);
  deepStrictEqual(client.calls, []);
});

Deno.test("returns 500 when source_health cannot be read", async () => {
  const { handler, calls } = build({ enabledError: new Error("PostgREST GET returned HTTP 503") });
  strictEqual((await handler(tick())).status, 500);
  deepStrictEqual(calls, ["enabled"]);
});

Deno.test("records a success heartbeat and skips polling on a non-trading day", async () => {
  const closedCalendar = fakeClient();
  closedCalendar.tradingDays = async () => {
    closedCalendar.calls.push("tradingDays");
    return new Set(["2026-10-09", "2026-10-12", "2026-10-13"]);
  };
  const { handler, calls, client } = build({ client: closedCalendar });
  const body = await (await handler(tick())).json();
  strictEqual(body.status, "non_trading_day");
  strictEqual(body.date, TODAY);
  ok(calls.includes("health:success"));
  ok(!calls.some((call) => call.startsWith("begin:")));
  ok(!client.calls.some((call) => call.startsWith("indexSnapshot")));
});

Deno.test("keeps polling when the calendar cannot be fetched", async () => {
  const client = fakeClient({ errors: { tradingDays: new Error("calendar 503") } });
  const { handler, finishes } = build({ client });
  strictEqual((await (await handler(tick())).json()).status, "ok");
  strictEqual(finishes[0]?.outcome, "ok");
});

Deno.test("caches the trading calendar between ticks on the same day", async () => {
  const client = fakeClient();
  const { handler } = build({ client });
  await handler(tick());
  await handler(tick());
  strictEqual(client.calls.filter((call) => call === "tradingDays").length, 1);
});

Deno.test("skips the tick when another run holds the lease", async () => {
  const { handler, calls, client, finishes } = build({ leaseGranted: false });
  const response = await handler(tick());
  strictEqual(response.status, 200);
  strictEqual((await response.json()).status, "skipped");
  deepStrictEqual(calls, ["enabled", "targets", `begin:${HOLDER}:${LEASE_SECONDS}`]);
  deepStrictEqual(client.calls, ["tradingDays"]);
  strictEqual(finishes.length, 0);
});

Deno.test("persists index and stock prices, pools and special lists, then releases the lease as ok", async () => {
  const { handler, quotes, snapshots, finishes, calls } = build();
  const response = await handler(tick());
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  deepStrictEqual(
    quotes.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [
      { symbol: "MOUTAI", price: 1500, ts: WEDNESDAY_10_00_BJ },
      { symbol: "SH000001", price: 3200, ts: WEDNESDAY_10_00_BJ },
    ],
  );
  const kinds = snapshots.map((row) => row.kind).sort();
  for (const kind of [
    "ths_limit_down_pool",
    "ths_limit_break_pool",
    "ths_limit_up_ladder",
    "ths_limit_up_pool",
    "ths_hot_stock_day",
    "ths_hot_stock_hour",
    "ths_skyrocket_day",
    "ths_anomaly_list",
    "ths_dragon_tiger",
    "ths_auction_benchmark",
  ]) {
    ok(kinds.includes(kind), `missing ${kind}`);
  }
  ok(snapshots.every((row) => row.date === TODAY));
  ok(calls.includes("health:success"));
  strictEqual(finishes.length, 1);
  deepStrictEqual(
    { holder: finishes[0]?.holder, outcome: finishes[0]?.outcome, backoff: finishes[0]?.backoff },
    { holder: HOLDER, outcome: "ok", backoff: 0 },
  );
});

Deno.test("sends only opted-in stock codes to the live auction snapshot before 09:25", async () => {
  const { handler, client, snapshots } = build({ now: WEDNESDAY_09_20_BJ });
  strictEqual((await (await handler(tick())).json()).status, "ok");
  ok(client.calls.includes("auctionSnapshot:live:600519.SH"));
  ok(!client.calls.some((call) => call.startsWith("auctionSnapshot:live:") && call.includes("000001.SH")));
  ok(snapshots.some((row) => row.kind === "ths_auction_live"));
});

Deno.test("collects breadth on a 30-minute boundary", async () => {
  const { handler, client, snapshots } = build({ now: WEDNESDAY_15_00_BJ });
  strictEqual((await (await handler(tick())).json()).status, "ok");
  const breadth = snapshots.find((row) => row.kind === "ths_breadth");
  const data = breadth?.payload.data as { total: number; up: number; down: number; flat: number; unknown: number };
  deepStrictEqual(
    { total: data.total, up: data.up, down: data.down, flat: data.flat, unknown: data.unknown },
    { total: 2, up: 1, down: 1, flat: 0, unknown: 0 },
  );
  ok(client.calls.includes("marketSnapshotPage"));
});

Deno.test("appends a new breadth point on the next boundary instead of skipping", async () => {
  const { handler, client, snapshots } = build({ now: WEDNESDAY_15_00_BJ, existingKinds: ["ths_breadth"] });
  await handler(tick());
  ok(client.calls.includes("marketSnapshotPage"));
  ok(snapshots.some((row) => row.kind === "ths_breadth"));
});

Deno.test("backs off for the rate-limit window and reports rate_limited", async () => {
  const client = fakeClient({ errors: { indexSnapshot: new ThsError("indexSnapshot returned HTTP 429", "rate_limited") } });
  const { handler, finishes } = build({ client });
  strictEqual((await (await handler(tick())).json()).status, "rate_limited");
  strictEqual(finishes[0]?.outcome, "rate_limited");
  strictEqual(finishes[0]?.backoff, RATE_LIMIT_BACKOFF_SECONDS);
});

Deno.test("treats one failed endpoint as degraded when other endpoints persist", async () => {
  const client = fakeClient({ errors: { stockSnapshot: new ThsError("stockSnapshot returned HTTP 500", "server") } });
  const { handler, finishes, quotes } = build({ client });
  strictEqual((await (await handler(tick())).json()).status, "degraded");
  strictEqual(finishes[0]?.outcome, "degraded");
  strictEqual(finishes[0]?.backoff, 0);
  ok(quotes.some((row) => row.symbol === "SH000001"));
});

Deno.test("stops the cycle on an auth failure and reports auth_error without backoff", async () => {
  const client = fakeClient({ errors: { indexSnapshot: new ThsError("indexSnapshot returned HTTP 401", "auth") } });
  const { handler, finishes } = build({ client });
  strictEqual((await (await handler(tick())).json()).status, "auth_error");
  strictEqual(finishes[0]?.outcome, "auth_error");
  strictEqual(finishes[0]?.backoff, 0);
});

Deno.test("releases the lease with outcome error when the cycle throws", async () => {
  const { handler, finishes } = build({ healthError: new Error("PostgREST POST returned HTTP 500") });
  strictEqual((await handler(tick())).status, 500);
  strictEqual(finishes.length, 1);
  strictEqual(finishes[0]?.outcome, "error");
  strictEqual(finishes[0]?.backoff, 0);
});

Deno.test("calendarStatusFor treats a listed day as trading and a missing day as closed only when the list is current", () => {
  deepStrictEqual(calendarStatusFor("2026-10-14", new Set(["2026-10-14"])), "trading");
  deepStrictEqual(calendarStatusFor("2026-10-14", new Set(["2026-10-13"])), "closed");
  deepStrictEqual(calendarStatusFor("2026-10-14", new Set(["2026-09-30"])), "unknown");
});

Deno.test("calendarStatusFor on Monday treats the previous Friday as the latest required day", () => {
  deepStrictEqual(calendarStatusFor("2026-10-12", new Set(["2026-10-09"])), "closed");
  deepStrictEqual(calendarStatusFor("2026-10-12", new Set(["2026-10-08"])), "unknown");
});
