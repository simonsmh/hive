import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createRestTrendStore } from "./store.ts";

const BASE = "https://project.supabase.co";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

function fakeFetch(respond: (call: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: Recorded = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const payload = respond(call);
    return Promise.resolve(new Response(payload === undefined ? "" : JSON.stringify(payload), { status: 200 }));
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const INSTANCE_ROW = {
  id: "tf-1",
  mode: "live",
  run_mode: "shadow",
  inst_id: "NVDA-USDT-SWAP",
  symbol: "NVDA",
  direction: "long",
  pos_side: "net",
  td_mode: "isolated",
  lever: "20",
  first_sz: "0.01",
  theme: "trend-probe",
  theme_stop_cap_u: "0.1",
  params: { atrLen: 14 },
  state: { positionSz: 0 },
  status: "armed",
  expires_at: "2026-10-21T13:00:00.000Z",
};

Deno.test("listActiveInstances maps rows and filters to armed/active of the mode", async () => {
  const { calls, fetchImpl } = fakeFetch(() => [INSTANCE_ROW]);
  const store = createRestTrendStore({ supabaseUrl: BASE, serviceKey: "svc", fetchImpl });
  const rows = await store.listActiveInstances("live");
  strictEqual(rows.length, 1);
  strictEqual(rows[0]!.runMode, "shadow");
  strictEqual(rows[0]!.lever, 20);
  strictEqual(rows[0]!.firstSz, "0.01");
  strictEqual(rows[0]!.expiresAtMs, Date.parse("2026-10-21T13:00:00.000Z"));
  ok(decodeURIComponent(calls[0]!.path).includes("status=in.(armed,active)"));
  ok(decodeURIComponent(calls[0]!.path).includes("mode=eq.live"));
});

Deno.test("recordEval patches only live rows and serializes the state", async () => {
  const { calls, fetchImpl } = fakeFetch(() => undefined);
  const store = createRestTrendStore({ supabaseUrl: BASE, serviceKey: "svc", fetchImpl });
  await store.recordEval("tf-1", {
    lastEvalAt: "2026-10-20T13:00:00.000Z",
    lastNote: "opened",
    status: "active",
    state: {
      entryPx: 109,
      entryBarTs: null,
      entryAtr: null,
      peakAtr: null,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      lastAddBarTs: null,
      lastEvalBarTs: null,
      lastChecksKey: null,
      exitReason: null,
    },
  });
  strictEqual(calls[0]!.method, "PATCH");
  ok(decodeURIComponent(calls[0]!.path).includes("status=in.(armed,active)"));
  const body = calls[0]!.body as Record<string, unknown>;
  strictEqual(body.status, "active");
  deepStrictEqual((body.state as Record<string, unknown>).stopPx, 99.25);
});

Deno.test("claim goes through the lease RPC and insertEvent appends a row", async () => {
  const { calls, fetchImpl } = fakeFetch((call) => (call.path.includes("hive_trend_claim") ? true : undefined));
  const store = createRestTrendStore({ supabaseUrl: BASE, serviceKey: "svc", fetchImpl });
  strictEqual(await store.claim("tf-1", 300), true);
  ok(calls[0]!.path.includes("/rest/v1/rpc/hive_trend_claim"));
  await store.insertEvent({ instanceId: "tf-1", kind: "trigger_fired", detail: { close: 109 } });
  const eventCall = calls[1]!;
  strictEqual(eventCall.method, "POST");
  ok(eventCall.path.includes("/rest/v1/trend_strategy_events"));
  deepStrictEqual(eventCall.body, { instance_id: "tf-1", kind: "trigger_fired", detail: { close: 109 } });
});

Deno.test("confirmedCandles returns ascending confirmed bars with numeric fields", async () => {
  const rows = [
    { ts: "2026-10-20T12:55:00.000Z", open: "101", high: "102", low: "100", close: "101.5", volume: "10", vol_ccy: "1015" },
    { ts: "2026-10-20T12:50:00.000Z", open: "100", high: "101", low: "99", close: "101", volume: "9", vol_ccy: "909" },
  ];
  const { calls, fetchImpl } = fakeFetch(() => rows);
  const store = createRestTrendStore({ supabaseUrl: BASE, serviceKey: "svc", fetchImpl });
  const bars = await store.confirmedCandles("NVDA", "5m", 80);
  strictEqual(bars.length, 2);
  strictEqual(bars[0]!.close, 101);
  strictEqual(bars[1]!.close, 101.5);
  ok(decodeURIComponent(calls[0]!.path).includes("interval=eq.5m"));
  ok(decodeURIComponent(calls[0]!.path).includes("confirmed=eq.true"));
});
