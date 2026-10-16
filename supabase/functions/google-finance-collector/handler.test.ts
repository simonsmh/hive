import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  BLOCKED_BACKOFF_SECONDS,
  createGoogleFinanceCollectorHandler,
  type EarningsStore,
  type EarningsWatchRow,
  parseCollectRequest,
  type RecordBatch,
  selectTargets,
} from "./handler.ts";

const SECRET = "test-cron-secret";
const NOW = Date.parse("2026-10-15T06:00:00Z");
const URL_TARGET = "https://collector.test/functions/v1/google-finance-collector";

const CARDS = [
  "For Q4 2026, TSMC expects revenue between $52.3 billion and $54.3 billion, representing a 14% sequential increase.",
  "Gross margin is guided to 65%-67%, reflecting continued 2nm ramp dilution.",
  "TSMC reiterated its full-year 2026 capital budget of $60 billion to $64 billion.",
  "Full-year 2026 revenue growth is expected to reach around 44% year-over-year.",
];

const SEGMENTS: Array<[number, number, string]> = [
  [454.8, 562.02, "Good afternoon, everyone, and welcome to TSMC's third quarter 2026 earnings conference call."],
  [2100.4, 2110, "Our fourth quarter revenue to be between 52.3 and 54.3 billion US dollars."],
];

function glanceBody(texts: string[] = CARDS): string {
  const cards = texts.map((text, i) => [null, "", text, null, null, "Wendell Huang", "CFO", "TSMC", 600 + i]);
  return `)]}'\n\n${JSON.stringify([["wrb.fr", "Xs5i3b", JSON.stringify([["TSM", "NYSE"], cards])]])}\n`;
}

function transcriptBody(): string {
  const payload = [SEGMENTS.map(([start, end, text], i) => [start, end, text, i]), 4794, false];
  return `)]}'\n\n${JSON.stringify([["wrb.fr", null, JSON.stringify(payload)]])}\n`;
}

const PAGE = '<script>"cfb2h":"boq_finhub-uiserver_20261013.05_p1","FdrFJe":"-1561769311453352629"</script>';

type Route = "page" | "glance" | "transcript";
interface Reply {
  status?: number;
  body: string;
}

function fakeGoogle(overrides: Partial<Record<Route, Reply>> = {}) {
  const calls: Array<{ route: Route; url: string; method: string; body?: string }> = [];
  const defaults: Record<Route, Reply> = {
    page: { body: PAGE },
    glance: { body: glanceBody() },
    transcript: { body: transcriptBody() },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const route: Route = url.includes("/finance/quote/") ? "page" : url.includes("batchexecute") ? "glance" : "transcript";
    calls.push({ route, url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    const reply = overrides[route] ?? defaults[route];
    return new Response(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface FakeStoreOptions {
  rows?: EarningsWatchRow[];
  leaseGranted?: boolean;
  listError?: Error;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const events: string[] = [];
  const recorded: Array<{ googleSymbol: string; symbol: string; batch: RecordBatch }> = [];
  const sessions: Array<{ googleSymbol: string; bl: string | null; refreshedAtMs: number }> = [];
  const finishes: Array<{ outcome: string; backoff: number }> = [];
  const failures: string[] = [];
  let successes = 0;
  const store: EarningsStore = {
    async listWatch() {
      events.push("list");
      if (options.listError) throw options.listError;
      return options.rows ?? [];
    },
    async saveSession(googleSymbol, session, refreshedAtMs) {
      events.push("session");
      sessions.push({ googleSymbol, bl: session.bl, refreshedAtMs });
    },
    async record(googleSymbol, symbol, batch) {
      events.push("record");
      recorded.push({ googleSymbol, symbol, batch });
      return { snapshots: batch.snapshot ? 1 : 0, segments: batch.segments.length, alerts: batch.alerts.length };
    },
    async beginRun() {
      events.push("begin");
      return options.leaseGranted ?? true;
    },
    async finishRun(_holder, outcome, backoff) {
      events.push("finish");
      finishes.push({ outcome, backoff });
    },
    async recordSuccess() {
      events.push("success");
      successes += 1;
    },
    async recordFailure(error) {
      events.push("failure");
      failures.push(error);
    },
  };
  return { store, events, recorded, sessions, finishes, failures, successes: () => successes };
}

function row(overrides: Partial<EarningsWatchRow> = {}): EarningsWatchRow {
  return {
    googleSymbol: "TSM:NYSE",
    symbol: "TSM",
    isPrimary: true,
    enabled: false,
    callTimeMs: null,
    preMinutes: 30,
    postMinutes: 180,
    okxInstId: "TSM-USDT-SWAP",
    session: { bl: "boq_finhub-uiserver_20261013.05_p1", sid: null },
    sessionRefreshedAtMs: NOW - 1_000,
    ...overrides,
  };
}

function request(body: unknown, init: { method?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.auth !== null) headers.authorization = init.auth ?? `Bearer ${SECRET}`;
  return new Request(URL_TARGET, {
    method: init.method ?? "POST",
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function build(options: { google: ReturnType<typeof fakeGoogle>; store: ReturnType<typeof fakeStore>; cronSecret?: string | undefined }) {
  return createGoogleFinanceCollectorHandler({
    cronSecret: "cronSecret" in options ? options.cronSecret : SECRET,
    store: options.store.store,
    fetchImpl: options.google.fetchImpl,
    now: () => NOW,
    newHolder: () => "holder-1",
    log: () => {},
  });
}

Deno.test("rejects wrong method, missing secret and bad bearer before touching anything", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW })] });
  const handler = build({ google, store });
  strictEqual((await handler(request(undefined, { method: "GET" }))).status, 405);
  strictEqual((await handler(request({}, { auth: "Bearer wrong" }))).status, 401);
  strictEqual((await handler(request({}, { auth: null }))).status, 401);
  strictEqual((await build({ google, store, cronSecret: undefined })(request({}))).status, 500);
  strictEqual(google.calls.length, 0);
  strictEqual(store.events.length, 0);
});

Deno.test("returns 400 for a malformed body without reading Google", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row()] });
  const handler = build({ google, store });
  strictEqual((await handler(request("{not json"))).status, 400);
  strictEqual((await handler(request({ symbol: 5 }))).status, 400);
  strictEqual((await handler(request({ symbol: "TSM", exchange: "NYSE" }))).status, 400);
  strictEqual((await handler(request({ exchangeSymbol: "TSM" }))).status, 400);
  strictEqual((await handler(request({ symbol: "tsm" }))).status, 400);
  strictEqual((await handler(request({ dryRun: "yes" }))).status, 400);
  strictEqual(google.calls.length, 0);
});

Deno.test("a scheduled tick is idle outside every call window and never calls Google", async () => {
  const google = fakeGoogle();
  const store = fakeStore({
    rows: [row({ enabled: false, callTimeMs: NOW }), row({ googleSymbol: "2330:TPE", isPrimary: false, enabled: true, callTimeMs: NOW + 5 * 3_600_000 })],
  });
  const response = await build({ google, store })(request({}));
  const body = await response.json();
  strictEqual(response.status, 200);
  strictEqual(body.status, "idle");
  strictEqual(google.calls.length, 0);
  deepStrictEqual(store.events, ["list"]);
});

Deno.test("an explicit symbol that is not mapped returns 404", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row()] });
  const response = await build({ google, store })(request({ exchangeSymbol: "XYZ", exchange: "NYSE" }));
  strictEqual(response.status, 404);
  strictEqual(google.calls.length, 0);
});

Deno.test("a dry run fetches the page, glance and transcript, and writes nothing", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row({ sessionRefreshedAtMs: null })] });
  const response = await build({ google, store })(request({ exchangeSymbol: "TSM", exchange: "NYSE", dryRun: true }));
  const body = await response.json();

  strictEqual(response.status, 200);
  strictEqual(body.status, "ok");
  deepStrictEqual(store.events, ["list"]);
  deepStrictEqual(google.calls.map((c) => c.route), ["page", "glance", "transcript"]);
  strictEqual(new URL(google.calls[1]?.url ?? "").searchParams.get("bl"), "boq_finhub-uiserver_20261013.05_p1");
  const result = body.results[0];
  strictEqual(result.glanceCards, 4);
  strictEqual(result.transcriptSegments, 2);
  strictEqual(result.findings.revenue_guidance_usd_b.value, "52.3-54.3");
  strictEqual(result.findings.capex_guidance_usd_b.value, "60-64");
  strictEqual(result.alerts, 0);
  strictEqual(result.inCallWindow, false);
  ok(Array.isArray(result.cards));
});

Deno.test("a scheduled tick inside the window stores the snapshot, segments and critical alerts", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW + 10 * 60_000 })] });
  const response = await build({ google, store })(request({}));
  const body = await response.json();

  strictEqual(body.status, "ok");
  deepStrictEqual(store.events, ["list", "begin", "record", "success", "finish"]);
  const recorded = store.recorded[0];
  strictEqual(recorded?.googleSymbol, "TSM:NYSE");
  strictEqual(recorded?.symbol, "TSM");
  strictEqual(recorded?.batch.segments.length, 2);
  strictEqual(recorded?.batch.snapshot?.cards.length, 4);
  deepStrictEqual(
    recorded?.batch.alerts.map((alert) => alert.dedupKey),
    [
      "earnings:TSM:2026-10-15:revenue_guidance_usd_b:52.3-54.3",
      "earnings:TSM:2026-10-15:gross_margin_guidance_pct:65-67",
      "earnings:TSM:2026-10-15:capex_guidance_usd_b:60-64",
      "earnings:TSM:2026-10-15:fy_revenue_growth_pct:44",
    ],
  );
  strictEqual(store.finishes[0]?.outcome, "ok");
  strictEqual(store.successes(), 1);
  ok(store.events.indexOf("begin") < store.events.indexOf("record"));
});

Deno.test("an out-of-window explicit run stores rows but emits no alerts", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row({ enabled: false, callTimeMs: NOW - 6 * 3_600_000 })] });
  const response = await build({ google, store })(request({ symbol: "TSM" }));
  const body = await response.json();
  strictEqual(body.status, "ok");
  strictEqual(store.recorded[0]?.batch.alerts.length, 0);
  strictEqual(store.recorded[0]?.batch.snapshot?.cards.length, 4);
});

Deno.test("the quote page is fetched once per session TTL and the refreshed token is saved", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW, sessionRefreshedAtMs: null, session: { bl: null, sid: null } })] });
  await build({ google, store })(request({}));
  deepStrictEqual(google.calls.map((c) => c.route), ["page", "glance", "transcript"]);
  strictEqual(store.sessions[0]?.bl, "boq_finhub-uiserver_20261013.05_p1");
  strictEqual(store.sessions[0]?.refreshedAtMs, NOW);

  const second = fakeGoogle();
  const fresh = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW, sessionRefreshedAtMs: NOW - 60_000 })] });
  await build({ google: second, store: fresh })(request({}));
  deepStrictEqual(second.calls.map((c) => c.route), ["glance", "transcript"]);
});

Deno.test("a 429 from Google stops the run and backs off for 15 minutes without writing", async () => {
  const google = fakeGoogle({ glance: { status: 429, body: "" } });
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW })] });
  const response = await build({ google, store })(request({}));
  const body = await response.json();
  strictEqual(body.status, "blocked");
  strictEqual(google.calls.filter((c) => c.route === "transcript").length, 0);
  strictEqual(store.finishes[0]?.backoff, BLOCKED_BACKOFF_SECONDS);
  strictEqual(store.recorded.length, 0);
  strictEqual(store.failures.length, 1);
});

Deno.test("a consent interstitial on the quote page is treated as blocked", async () => {
  const google = fakeGoogle({ page: { body: '<a href="https://consent.google.com/m">consent</a>' } });
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW, sessionRefreshedAtMs: null })] });
  await build({ google, store })(request({}));
  strictEqual(store.finishes[0]?.outcome, "blocked");
  strictEqual(google.calls.length, 1);
});

Deno.test("a glance failure with a transcript still stores the transcript and reports partial", async () => {
  const google = fakeGoogle({ glance: { status: 400, body: ")]}'\n\n[[\"er\",null,null,null,null,400,null,null,null,9]]\n" } });
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW })] });
  const body = await (await build({ google, store })(request({}))).json();
  strictEqual(body.status, "degraded");
  strictEqual(body.results[0].status, "partial");
  strictEqual(body.results[0].errors[0].startsWith("glance:"), true);
  strictEqual(store.recorded[0]?.batch.snapshot, null);
  strictEqual(store.recorded[0]?.batch.segments.length, 2);
  strictEqual(store.finishes[0]?.outcome, "degraded");
  strictEqual(store.successes(), 1);
});

Deno.test("when both RPCs fail the target fails and the failure is recorded on source_health", async () => {
  const google = fakeGoogle({
    glance: { status: 400, body: "" },
    transcript: { status: 500, body: "" },
  });
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW })] });
  const body = await (await build({ google, store })(request({}))).json();
  strictEqual(body.status, "error");
  strictEqual(body.results[0].status, "failed");
  strictEqual(store.recorded.length, 0);
  strictEqual(store.failures.length, 1);
  strictEqual(store.finishes[0]?.outcome, "error");
});

Deno.test("a run that cannot take the lease is skipped without calling Google", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW })], leaseGranted: false });
  const body = await (await build({ google, store })(request({}))).json();
  strictEqual(body.status, "skipped");
  strictEqual(google.calls.length, 0);
});

Deno.test("a dry run never takes the lease", async () => {
  const google = fakeGoogle();
  const store = fakeStore({ rows: [row({ enabled: true, callTimeMs: NOW })], leaseGranted: false });
  const response = await build({ google, store })(request({ symbol: "TSM", dryRun: true }));
  strictEqual((await response.json()).status, "ok");
  ok(!store.events.includes("begin"));
});

Deno.test("parseCollectRequest accepts the three documented shapes and rejects mixed ones", () => {
  deepStrictEqual(parseCollectRequest(""), { symbol: null, exchangeSymbol: null, exchange: null, dryRun: false });
  deepStrictEqual(parseCollectRequest('{"symbol":"TSM"}'), { symbol: "TSM", exchangeSymbol: null, exchange: null, dryRun: false });
  deepStrictEqual(parseCollectRequest('{"exchangeSymbol":"2330","exchange":"TPE","dryRun":true}'), {
    symbol: null,
    exchangeSymbol: "2330",
    exchange: "TPE",
    dryRun: true,
  });
  let rejected = 0;
  for (const text of ['{"symbol":"TSM","exchange":"NYSE"}', '{"symbol":"TSM","exchangeSymbol":"TSM"}', "[]", '{"exchange":"NYSE"}']) {
    try {
      parseCollectRequest(text);
    } catch {
      rejected += 1;
    }
  }
  strictEqual(rejected, 4);
});

Deno.test("selectTargets prefers the primary row for a Hive symbol and ignores windows for explicit requests", () => {
  const rows = [
    row({ googleSymbol: "2330:TPE", isPrimary: false, enabled: true, callTimeMs: NOW }),
    row({ googleSymbol: "TSM:NYSE", isPrimary: true, enabled: false, callTimeMs: null }),
  ];
  const bySymbol = selectTargets(rows, { symbol: "TSM", exchangeSymbol: null, exchange: null, dryRun: false }, NOW);
  deepStrictEqual(bySymbol.targets.map((t) => t.googleSymbol), ["TSM:NYSE"]);
  const byExchange = selectTargets(rows, { symbol: null, exchangeSymbol: "2330", exchange: "TPE", dryRun: false }, NOW);
  deepStrictEqual(byExchange.targets.map((t) => t.googleSymbol), ["2330:TPE"]);
  const scheduled = selectTargets(rows, { symbol: null, exchangeSymbol: null, exchange: null, dryRun: false }, NOW);
  deepStrictEqual(scheduled.targets.map((t) => t.googleSymbol), ["2330:TPE"]);
});
