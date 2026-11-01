import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import { createRestSinaStore } from "./store.ts";

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
  const store = createRestSinaStore({ supabaseUrl: `${BASE}/`, serviceKey: SERVICE_KEY, fetchImpl });
  return { store, requests };
}

const candle: Candle = { ts: 1_791_900_780_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volCcy: 0, confirmed: false };

Deno.test("sends the service key only as auth headers to the project REST endpoint", async () => {
  const { store, requests } = recorder();
  await store.recordSourceSuccess("sina");
  const [request] = requests;
  strictEqual(request?.url, `${BASE}/rest/v1/rpc/hive_collector_record_success`);
  strictEqual(request?.headers.get("apikey"), SERVICE_KEY);
  strictEqual(request?.headers.get("authorization"), `Bearer ${SERVICE_KEY}`);
  deepStrictEqual(request?.body, { p_source: "sina" });
});

Deno.test("lists enabled symbols that have a ths_code, not the OKX instrument", async () => {
  const { store, requests } = recorder(
    () =>
      new Response(
        JSON.stringify([
          { symbol: "HTGD", ths_code: "600487.SH" },
          { symbol: "DML", ths_code: "001309.SZ" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  deepStrictEqual(await store.listSymbols(), [
    { symbol: "HTGD", thsCode: "600487.SH" },
    { symbol: "DML", thsCode: "001309.SZ" },
  ]);
  const url = requests[0]?.url ?? "";
  ok(url.includes("/rest/v1/symbol_map?select=symbol,ths_code&enabled=eq.true&ths_code=not.is.null"));
  strictEqual(requests[0]?.method, "GET");
});

Deno.test("serialises daily candles with the column names the SQL function expects", async () => {
  const { store, requests } = recorder(() => new Response("1", { status: 200 }));
  strictEqual(await store.upsertCandles("HTGD", "sina", "1D", [candle]), 1);
  strictEqual(requests[0]?.url, `${BASE}/rest/v1/rpc/hive_collector_upsert_candles`);
  deepStrictEqual(requests[0]?.body, {
    p_symbol: "HTGD",
    p_source: "sina",
    p_interval: "1D",
    p_candles: [
      { ts: 1_791_900_780_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, vol_ccy: 0, confirmed: false },
    ],
  });
});

Deno.test("does not call the database for an empty candle batch", async () => {
  const { store, requests } = recorder();
  strictEqual(await store.upsertCandles("HTGD", "sina", "1D", []), 0);
  strictEqual(requests.length, 0);
});

Deno.test("begins and finishes the lease under source sina", async () => {
  const { store, requests } = recorder((captured) =>
    captured.url.endsWith("hive_collector_begin") ? new Response("false", { status: 200 }) : new Response(null, { status: 204 }),
  );
  strictEqual(await store.beginRun("holder", 150), false);
  deepStrictEqual(requests[0]?.body, { p_source: "sina", p_holder: "holder", p_lease_seconds: 150 });

  await store.finishRun("holder", "rate_limited", 600, { successes: 0 });
  strictEqual(requests[1]?.url, `${BASE}/rest/v1/rpc/hive_collector_finish`);
  deepStrictEqual(requests[1]?.body, {
    p_source: "sina",
    p_holder: "holder",
    p_outcome: "rate_limited",
    p_backoff_seconds: 600,
    p_summary: { successes: 0 },
  });
});

Deno.test("truncates recorded errors to 500 characters", async () => {
  const { store, requests } = recorder();
  strictEqual(await store.recordSourceFailure("sina", "x".repeat(900)), undefined);
  strictEqual((requests[0]?.body as { p_error: string }).p_error.length, 500);
});

Deno.test("turns a non-2xx response into an error that names the call but not the key", async () => {
  const { store } = recorder(() => new Response('{"message":"invalid input"}', { status: 400 }));
  await rejects(store.upsertCandles("HTGD", "sina", "1D", [candle]), (error: Error) => {
    match(error.message, /PostgREST POST \/rest\/v1\/rpc\/hive_collector_upsert_candles returned HTTP 400: \{"message":"invalid input"\}/);
    ok(!error.message.includes(SERVICE_KEY));
    return true;
  });
});
