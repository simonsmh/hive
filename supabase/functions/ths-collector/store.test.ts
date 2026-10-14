import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { createRestThsStore } from "./store.ts";

const SERVICE_KEY = "service-key-that-must-not-leak";
const BASE = "https://project.supabase.test";

interface Captured {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

function recorder(responder: (captured: Captured) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const requests: Captured[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const captured: Captured = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(captured);
    return responder(captured);
  };
  const store = createRestThsStore({ supabaseUrl: `${BASE}/`, serviceKey: SERVICE_KEY, fetchImpl });
  return { store, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.test("sends the service key only as auth headers to the project REST endpoint", async () => {
  const { store, requests } = recorder();
  await store.recordSourceSuccess("ths");
  const [request] = requests;
  strictEqual(request?.url, `${BASE}/rest/v1/rpc/hive_collector_record_success`);
  strictEqual(request?.headers.get("apikey"), SERVICE_KEY);
  strictEqual(request?.headers.get("authorization"), `Bearer ${SERVICE_KEY}`);
  deepStrictEqual(request?.body, { p_source: "ths" });
});

Deno.test("reads the ths source switch from source_health", async () => {
  const enabled = recorder(() => json([{ enabled: true }]));
  strictEqual(await enabled.store.isSourceEnabled(), true);
  strictEqual(
    enabled.requests[0]?.url,
    `${BASE}/rest/v1/source_health?select=enabled&source=eq.ths`,
  );

  const disabled = recorder(() => json([{ enabled: false }]));
  strictEqual(await disabled.store.isSourceEnabled(), false);

  const missing = recorder(() => json([]));
  strictEqual(await missing.store.isSourceEnabled(), false);
});

Deno.test("lists only enabled ths symbols and drops rows with an invalid code or kind", async () => {
  const { store, requests } = recorder(() =>
    json([
      { symbol: "SH000001", ths_code: "000001.SH", ths_kind: "index", ths_auction: false },
      { symbol: "MOUTAI", ths_code: "600519.SH", ths_kind: "stock", ths_auction: true },
      { symbol: "BAD", ths_code: "ABC", ths_kind: "stock", ths_auction: false },
      { symbol: "ETF", ths_code: "510300.SH", ths_kind: "etf", ths_auction: false },
      { symbol: "NOAUC", ths_code: "000858.SZ", ths_kind: "stock", ths_auction: null },
    ]),
  );
  const targets = await store.listTargets();
  deepStrictEqual(targets, [
    { symbol: "SH000001", thscode: "000001.SH", kind: "index", auction: false },
    { symbol: "MOUTAI", thscode: "600519.SH", kind: "stock", auction: true },
    { symbol: "NOAUC", thscode: "000858.SZ", kind: "stock", auction: false },
  ]);
  const url = new URL(requests[0]?.url ?? "");
  strictEqual(url.pathname, "/rest/v1/symbol_map");
  strictEqual(url.searchParams.get("enabled"), "eq.true");
  strictEqual(url.searchParams.get("ths_code"), "not.is.null");
  strictEqual(url.searchParams.get("select"), "symbol,ths_code,ths_kind,ths_auction");
});

Deno.test("maps a quote onto the ths-tagged SQL function arguments", async () => {
  const { store, requests } = recorder();
  await store.upsertQuote("MOUTAI", "ths", { symbol: "MOUTAI", price: 1500.5, ts: 1000 });
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/rpc/hive_collector_upsert_quote`);
  deepStrictEqual(requests[0]?.body, { p_symbol: "MOUTAI", p_source: "ths", p_price: 1500.5, p_ts_ms: 1000 });
});

Deno.test("stores a daily snapshot through the snapshot function with its kind and payload", async () => {
  const { store, requests } = recorder();
  await store.upsertDailySnapshot("2026-10-14", "ths_limit_up_pool", { fetched_at: "t", data: { item: [] } });
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/rpc/hive_collector_upsert_daily_snapshot`);
  deepStrictEqual(requests[0]?.body, {
    p_date: "2026-10-14",
    p_kind: "ths_limit_up_pool",
    p_payload: { fetched_at: "t", data: { item: [] } },
  });
});

Deno.test("checks whether a daily snapshot already exists for the date and kind", async () => {
  const present = recorder(() => json([{ kind: "ths_breadth" }]));
  strictEqual(await present.store.snapshotExists("2026-10-14", "ths_breadth"), true);
  const query = new URL(present.requests[0]?.url ?? "").searchParams;
  strictEqual(query.get("snapshot_date"), "eq.2026-10-14");
  strictEqual(query.get("kind"), "eq.ths_breadth");
  strictEqual(query.get("limit"), "1");

  const absent = recorder(() => json([]));
  strictEqual(await absent.store.snapshotExists("2026-10-14", "ths_breadth"), false);
});

Deno.test("reports a lease as held when the SQL function declines", async () => {
  const granted = recorder(() => new Response("true", { status: 200 }));
  strictEqual(await granted.store.beginRun("holder", 90), true);
  deepStrictEqual(granted.requests[0]?.body, { p_source: "ths", p_holder: "holder", p_lease_seconds: 90 });

  const declined = recorder(() => new Response("false", { status: 200 }));
  strictEqual(await declined.store.beginRun("holder", 90), false);
});

Deno.test("sends the run outcome and backoff when finishing", async () => {
  const { store, requests } = recorder();
  await store.finishRun("holder", "rate_limited", 300, { persisted: 0 });
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/rpc/hive_collector_finish`);
  deepStrictEqual(requests[0]?.body, {
    p_source: "ths",
    p_holder: "holder",
    p_outcome: "rate_limited",
    p_backoff_seconds: 300,
    p_summary: { persisted: 0 },
  });
});

Deno.test("truncates recorded errors to 500 characters", async () => {
  const { store, requests } = recorder();
  await store.recordSourceFailure("ths", "x".repeat(900));
  strictEqual((requests[0]?.body as { p_error: string }).p_error.length, 500);
});

Deno.test("turns a non-2xx response into an error that names the call but not the key", async () => {
  const { store } = recorder(() => new Response('{"message":"invalid input"}', { status: 400 }));
  const failure = store.upsertQuote("MOUTAI", "ths", { symbol: "MOUTAI", price: 1, ts: 1 });
  await rejects(failure, (error: Error) => {
    match(
      error.message,
      /PostgREST POST \/rest\/v1\/rpc\/hive_collector_upsert_quote returned HTTP 400: \{"message":"invalid input"\}/,
    );
    ok(!error.message.includes(SERVICE_KEY));
    return true;
  });
});
