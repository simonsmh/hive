import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createRestStrategyStore } from "./store.ts";

const BASE = "https://project.supabase.co";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (call: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: Recorded = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const payload = respond(call);
    return Promise.resolve(new Response(payload === undefined ? "" : JSON.stringify(payload), { status: 200 }));
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const ORDER_ROW = {
  id: "ord-1",
  mode: "live",
  inst_id: "NVDA-USDT-SWAP",
  symbol: "NVDA",
  template: "reversal_long",
  pos_side: "net",
  td_mode: "isolated",
  lever: "3",
  sz: "0.01",
  theme: "reversal-oct",
  theme_stop_cap_u: "0.1",
  tp_pct: null,
  params: { interval: "1D" },
  status: "primed",
  setup_low: "96",
  setup_low_ts: "2026-10-14T00:00:00.000Z",
  drawdown_pct: "13.2",
  invalidations: "1",
  expires_at: "2026-11-01T00:00:00.000Z",
};

Deno.test("listActiveOrders maps the row and filters to active statuses for the mode", async () => {
  const { calls, fetchImpl } = fakeFetch(() => [ORDER_ROW]);
  const store = createRestStrategyStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl });
  const orders = await store.listActiveOrders("live");
  strictEqual(orders.length, 1);
  const order = orders[0]!;
  strictEqual(order.instId, "NVDA-USDT-SWAP");
  strictEqual(order.lever, 3);
  strictEqual(order.sz, "0.01");
  strictEqual(order.setupLow, 96);
  strictEqual(order.setupLowTs, Date.parse("2026-10-14T00:00:00.000Z"));
  strictEqual(order.invalidations, 1);
  ok(calls[0]!.path.includes("status=in.%28armed%2Cprimed%29") || calls[0]!.path.includes("status=in.(armed,primed)"));
  ok(calls[0]!.path.includes("mode=eq.live"));
});

Deno.test("confirmedCandles returns ascending bars and passes the since filter", async () => {
  const rows = [
    { ts: "2026-10-16T00:00:00.000Z", open: "98", high: "99", low: "97", close: "98.5", volume: "10", vol_ccy: "20" },
    { ts: "2026-10-15T00:00:00.000Z", open: "97", high: "98", low: "96", close: "97.5", volume: "9", vol_ccy: "18" },
  ];
  const { calls, fetchImpl } = fakeFetch(() => rows);
  const store = createRestStrategyStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl });
  const candles = await store.confirmedCandles("NVDA", "1D", 60, Date.parse("2026-10-14T00:00:00.000Z"));
  strictEqual(candles.length, 2);
  strictEqual(candles[0]!.close, 97.5);
  strictEqual(candles[1]!.close, 98.5);
  ok(calls[0]!.path.includes("ts=gte.2026-10-14"));
  ok(calls[0]!.path.includes("interval=eq.1D"));
});

Deno.test("recordEval patches only the columns the patch carries", async () => {
  const { calls, fetchImpl } = fakeFetch(() => undefined);
  const store = createRestStrategyStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl });
  await store.recordEval("ord-1", {
    lastEvalAt: "2026-10-18T12:00:00.000Z",
    lastNote: "fired",
    status: "fired",
    ordId: "ord-okx-1",
    setupLow: null,
  });
  strictEqual(calls[0]!.method, "PATCH");
  ok(decodeURIComponent(calls[0]!.path).includes("status=in.(armed,primed)"));
  deepStrictEqual(calls[0]!.body, {
    last_eval_at: "2026-10-18T12:00:00.000Z",
    last_note: "fired",
    updated_at: "2026-10-18T12:00:00.000Z",
    status: "fired",
    ord_id: "ord-okx-1",
    setup_low: null,
  });
});

Deno.test("getOrder maps the row and returns null when absent", async () => {
  const row = {
    id: "ord-1",
    mode: "live",
    inst_id: "NVDA-USDT-SWAP",
    symbol: "NVDA",
    template: "reversal_long",
    pos_side: "long",
    td_mode: "isolated",
    lever: 3,
    sz: "0.01",
    theme: "reversal-oct-nvda",
    theme_stop_cap_u: 0.1,
    tp_pct: null,
    params: {},
    status: "cancelled",
    setup_low: null,
    setup_low_ts: null,
    drawdown_pct: null,
    invalidations: 0,
    expires_at: "2026-11-01T00:00:00.000Z",
  };
  const { calls, fetchImpl } = fakeFetch(() => [row]);
  const store = createRestStrategyStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl });
  const order = await store.getOrder("ord-1");
  strictEqual(order?.status, "cancelled");
  strictEqual(order?.instId, "NVDA-USDT-SWAP");
  ok(calls[0]!.path.includes("id=eq.ord-1"));

  const empty = createRestStrategyStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: fakeFetch(() => []).fetchImpl });
  strictEqual(await empty.getOrder("ord-1"), null);
});

Deno.test("claim goes through the RPC and insertAlert ignores duplicates", async () => {
  const { calls, fetchImpl } = fakeFetch((call) => (call.path.includes("rpc") ? true : undefined));
  const store = createRestStrategyStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl });
  strictEqual(await store.claim("ord-1", 300), true);
  ok(calls[0]!.path.includes("/rest/v1/rpc/hive_conditional_claim"));
  deepStrictEqual(calls[0]!.body, { p_id: "ord-1", p_lease_seconds: 300 });

  await store.insertAlert({
    dedup_key: "conditional:ord-1:fired",
    rule_id: null,
    symbol: "NVDA",
    kind: "conditional_order_fired",
    severity: "critical",
    payload: {},
  });
  strictEqual(calls[1]!.path, "/rest/v1/alerts");
  ok((calls[1]!.headers.prefer ?? "").includes("resolution=ignore-duplicates"));
});
