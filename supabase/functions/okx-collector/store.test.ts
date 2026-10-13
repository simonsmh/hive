import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import { createRestStore } from "./store.ts";

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
  const store = createRestStore({
    supabaseUrl: `${BASE}/`,
    serviceKey: SERVICE_KEY,
    fetchImpl,
    now: () => new Date("2026-10-13T00:00:00.000Z"),
  });
  return { store, requests };
}

const candle: Candle = { ts: 1_791_900_780_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 15, confirmed: true };

Deno.test("sends the service key only as auth headers to the project REST endpoint", async () => {
  const { store, requests } = recorder();
  await store.recordSourceSuccess("okx");
  const [request] = requests;
  strictEqual(request?.url, `${BASE}/rest/v1/rpc/hive_collector_record_success`);
  strictEqual(request?.headers.get("apikey"), SERVICE_KEY);
  strictEqual(request?.headers.get("authorization"), `Bearer ${SERVICE_KEY}`);
  deepStrictEqual(request?.body, { p_source: "okx" });
});

Deno.test("maps a quote onto the SQL function arguments", async () => {
  const { store, requests } = recorder();
  await store.upsertQuote("NVDA", "okx", { symbol: "NVDA", price: 180.5, ts: 1000 });
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/rpc/hive_collector_upsert_quote`);
  deepStrictEqual(requests[0]?.body, { p_symbol: "NVDA", p_source: "okx", p_price: 180.5, p_ts_ms: 1000 });
});

Deno.test("serialises candles with the column names the SQL function expects", async () => {
  const { store, requests } = recorder(() => new Response("1", { status: 200 }));
  const written = await store.upsertCandles("BTC", "okx", "5m", [candle]);
  strictEqual(written, 1);
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/rpc/hive_collector_upsert_candles`);
  deepStrictEqual(requests[0]?.body, {
    p_symbol: "BTC",
    p_source: "okx",
    p_interval: "5m",
    p_candles: [
      {
        ts: 1_791_900_780_000,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
        vol_ccy: 15,
        confirmed: true,
      },
    ],
  });
});

Deno.test("does not call the database for an empty candle batch", async () => {
  const { store, requests } = recorder();
  strictEqual(await store.upsertCandles("BTC", "okx", "1m", []), 0);
  strictEqual(requests.length, 0);
});

Deno.test("truncates recorded errors to 500 characters", async () => {
  const { store, requests } = recorder();
  await store.recordSourceFailure("okx", "x".repeat(900));
  strictEqual((requests[0]?.body as { p_error: string }).p_error.length, 500);
});

Deno.test("lists enabled symbols with their stored OKX instrument ids", async () => {
  const { store, requests } = recorder(
    () =>
      new Response(
        JSON.stringify([
          { symbol: "BTC", okx_inst_id: "BTC-USDT-SWAP" },
          { symbol: "ETH", okx_inst_id: null },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const symbols = await store.listSymbols();
  deepStrictEqual(symbols, [
    { symbol: "BTC", okxInstId: "BTC-USDT-SWAP" },
    { symbol: "ETH", okxInstId: null },
  ]);
  ok(requests[0]?.url.includes("/rest/v1/symbol_map?select=symbol,okx_inst_id&enabled=eq.true"));
  strictEqual(requests[0]?.method, "GET");
});

Deno.test("patches the resolved instrument id with the symbol URL-encoded", async () => {
  const { store, requests } = recorder();
  await store.setInstId("ETH", "ETH-USDT-SWAP");
  strictEqual(requests[0]?.method, "PATCH");
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/symbol_map?symbol=eq.ETH`);
  strictEqual(requests[0]?.headers.get("prefer"), "return=minimal");
  strictEqual((requests[0]?.body as { okx_inst_id: string }).okx_inst_id, "ETH-USDT-SWAP");
});

Deno.test("reports a false lease when the SQL function declines", async () => {
  const { store, requests } = recorder(() => new Response("false", { status: 200 }));
  strictEqual(await store.beginRun("holder", 150), false);
  deepStrictEqual(requests[0]?.body, { p_source: "okx", p_holder: "holder", p_lease_seconds: 150 });
});

Deno.test("sends the run outcome and backoff when finishing", async () => {
  const { store, requests } = recorder();
  await store.finishRun("holder", "rate_limited", 300, { successes: 0 });
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/rpc/hive_collector_finish`);
  deepStrictEqual(requests[0]?.body, {
    p_source: "okx",
    p_holder: "holder",
    p_outcome: "rate_limited",
    p_backoff_seconds: 300,
    p_summary: { successes: 0 },
  });
});

Deno.test("turns a non-2xx response into an error that names the call but not the key", async () => {
  const { store } = recorder(() => new Response('{"message":"invalid input"}', { status: 400 }));
  const failure = store.upsertQuote("BTC", "okx", { symbol: "BTC", price: 1, ts: 1 });
  await rejects(failure, (error: Error) => {
    match(error.message, /PostgREST POST \/rest\/v1\/rpc\/hive_collector_upsert_quote returned HTTP 400: \{"message":"invalid input"\}/);
    ok(!error.message.includes(SERVICE_KEY));
    return true;
  });
});
