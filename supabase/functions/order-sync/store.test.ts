import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createRestOrderSyncStore } from "./store.ts";

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

Deno.test("listPending queries non-final orders of the mode, oldest sync first", async () => {
  const { calls, fetchImpl } = fakeFetch(() => [
    { id: 7, kind: "order", inst_id: "NVDA-USDT-SWAP", ord_id: "ord-7", algo_id: null, state: "accepted", fill_px: null, fill_sz: null },
    { id: 8, kind: "algo", inst_id: "NVDA-USDT-SWAP", ord_id: null, algo_id: "algo-8", state: "live", fill_px: "219.48", fill_sz: "0.01" },
  ]);
  const store = createRestOrderSyncStore({ supabaseUrl: BASE, serviceKey: "service-key", fetchImpl });
  const rows = await store.listPending("live", 100);
  strictEqual(calls.length, 1);
  strictEqual(calls[0]?.method, "GET");
  const query = new URLSearchParams(calls[0]?.path.split("?")[1]);
  strictEqual(query.get("mode"), "eq.live");
  strictEqual(query.get("state"), "in.(accepted,live,partially_filled,partially_effective)");
  strictEqual(query.get("limit"), "100");
  deepStrictEqual(rows[0], {
    id: 7,
    kind: "order",
    instId: "NVDA-USDT-SWAP",
    ordId: "ord-7",
    algoId: null,
    state: "accepted",
    fillPx: null,
    fillSz: null,
  });
  strictEqual(rows[1]?.fillPx, 219.48);
});

Deno.test("applySync patches only the columns present in the patch", async () => {
  const { calls, fetchImpl } = fakeFetch(() => undefined);
  const store = createRestOrderSyncStore({ supabaseUrl: BASE, serviceKey: "service-key", fetchImpl });
  await store.applySync(7, { lastSyncAt: "2026-10-19T12:00:00.000Z", state: "filled", fillPx: 219.48, fillSz: 0.01 });
  strictEqual(calls[0]?.method, "PATCH");
  strictEqual(calls[0]?.path, "/rest/v1/orders?id=eq.7");
  deepStrictEqual(calls[0]?.body, { last_sync_at: "2026-10-19T12:00:00.000Z", state: "filled", fill_px: 219.48, fill_sz: 0.01 });

  await store.applySync(7, { lastSyncAt: "2026-10-19T12:01:00.000Z" });
  deepStrictEqual(calls[1]?.body, { last_sync_at: "2026-10-19T12:01:00.000Z" });
});
