import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createRestOrderStore } from "./store.ts";

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

Deno.test("reads the kill switch and treats a missing row as engaged", async () => {
  const engaged = fakeFetch(() => [{ engaged: false }]);
  strictEqual(await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: engaged.fetchImpl }).killSwitchEngaged(), false);
  strictEqual(engaged.calls[0]?.path, "/rest/v1/kill_switch?select=engaged&id=eq.1");

  const missing = fakeFetch(() => []);
  strictEqual(await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: missing.fetchImpl }).killSwitchEngaged(), true);
});

Deno.test("loads the enabled risk limits for the mode and maps them to camelCase", async () => {
  const { calls, fetchImpl } = fakeFetch(() => [
    { symbol_allowlist: ["XAU-USDT-SWAP"], max_notional_usdt: "500", max_leverage: 20, max_orders_per_min: 5 },
  ]);
  const limits = await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl }).riskLimits("demo");
  deepStrictEqual(limits, {
    symbolAllowlist: ["XAU-USDT-SWAP"],
    maxNotionalUsdt: 500,
    maxLeverage: 20,
    maxOrdersPerMin: 5,
  });
  strictEqual(calls[0]?.path.startsWith("/rest/v1/risk_limits?"), true);
  ok(calls[0]?.path.includes("mode=eq.demo"));
  ok(calls[0]?.path.includes("enabled=eq.true"));
});

Deno.test("returns null when no enabled risk limits exist", async () => {
  const { fetchImpl } = fakeFetch(() => []);
  strictEqual(await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl }).riskLimits("live"), null);
});

Deno.test("insert returns inserted true for a new intent and the stored row for a repeat", async () => {
  const fresh = fakeFetch(() => ({ inserted: true }));
  const store = createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: fresh.fetchImpl });
  const record = {
    intentId: "int-1",
    idempotencyKey: "key-1",
    mode: "demo" as const,
    schemaVersion: "okx.intent.v1",
    action: "open" as const,
    source: "grok",
    instId: "XAU-USDT-SWAP",
    side: "sell" as const,
    posSide: "net" as const,
    tdMode: "isolated" as const,
    lever: 15,
    sz: "1",
    ordType: "market" as const,
    px: null,
    reduceOnly: false,
    slTriggerPx: "4125",
    slOrdPx: "-1",
    tpTriggerPx: null,
    tpOrdPx: null,
    theme: "xau_cpi",
    themeStopCapU: 0.1,
    maxLossU: null,
    reason: null,
    intentCreatedAt: "2026-10-14T14:40:00+08:00",
    ttlSec: 120,
    clOrdId: "h".repeat(32),
    request: { intentId: "int-1" },
  };
  deepStrictEqual(await store.insertIntent(record), { inserted: true });
  strictEqual(fresh.calls[0]?.path, "/rest/v1/rpc/hive_order_intent_insert");
  strictEqual((fresh.calls[0]?.body as { p_intent: { intent_id: string } }).p_intent.intent_id, "int-1");

  const repeat = fakeFetch(() => ({
    inserted: false,
    row: {
      status: "acked",
      reject_reason: null,
      ord_id: "42",
      algo_id: null,
      cl_ord_id: "h".repeat(32),
      detail: null,
      received_at: "2026-10-14T06:40:31.000Z",
    },
  }));
  const again = await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: repeat.fetchImpl }).insertIntent(record);
  deepStrictEqual(again, {
    inserted: false,
    existing: {
      status: "acked",
      reason: null,
      ordId: "42",
      algoId: null,
      clOrdId: "h".repeat(32),
      state: null,
      detail: null,
      receivedAtMs: Date.parse("2026-10-14T06:40:31.000Z"),
    },
  });
});

Deno.test("lists live Hive algos on an instrument with an encoded filter", async () => {
  const { calls, fetchImpl } = fakeFetch(() => [{ algo_id: "111", cl_ord_id: "a".repeat(32) }]);
  const algos = await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl }).liveAlgos("XAU-USDT-SWAP", "demo");
  deepStrictEqual(algos, [{ algoId: "111", clOrdId: "a".repeat(32) }]);
  ok(calls[0]?.path.includes("kind=eq.algo"));
  ok(calls[0]?.path.includes("state=in."));
  ok(calls[0]?.path.includes("inst_id=eq.XAU-USDT-SWAP"));
});

Deno.test("surfaces a PostgREST error so the handler can fail closed", async () => {
  const response = (): Promise<Response> => Promise.resolve(new Response("boom", { status: 503 }));
  const store = createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: response as typeof fetch });
  let message = "";
  try {
    await store.killSwitchEngaged();
  } catch (error) {
    message = (error as Error).message;
  }
  ok(message.includes("HTTP 503"));
});

function ok(condition: boolean): void {
  strictEqual(condition, true);
}

Deno.test("looks up an enabled subscription for the mode and instrument", async () => {
  const found = fakeFetch(() => [{ id: "sub-1" }]);
  strictEqual(
    await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: found.fetchImpl }).hasEnabledSubscription("live", "QQQ-USDT-SWAP"),
    true,
  );
  strictEqual(
    found.calls[0]?.path,
    "/rest/v1/position_subscriptions?select=id&mode=eq.live&inst_id=eq.QQQ-USDT-SWAP&enabled=eq.true&limit=1",
  );

  const none = fakeFetch(() => []);
  strictEqual(
    await createRestOrderStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: none.fetchImpl }).hasEnabledSubscription("live", "QQQ-USDT-SWAP"),
    false,
  );
});
