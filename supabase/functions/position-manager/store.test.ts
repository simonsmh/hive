import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createRestPositionStore } from "./store.ts";

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

const SUB_ROW = {
  id: "sub-1",
  mode: "live",
  inst_id: "BTC-USDT-SWAP",
  pos_side: "net",
  direction: "short",
  td_mode: "isolated",
  entry_px: "81818.5",
  sl_px: 82700,
  tp_px: 80400,
  mid_px: 82259.25,
  theme_stop_cap_u: 0.1,
  atr_len: 14,
  atr_mult: 0.8,
  amend_min_atr_frac: 0.15,
  half_reduce_frac: 0.5,
  dynamic_tp_enabled: true,
  half_reduce_enabled: true,
  half_reduce_done: false,
  half_reduce_attempts: 2,
};

Deno.test("reads the kill switch and treats a missing row as engaged", async () => {
  const engaged = fakeFetch(() => [{ engaged: false }]);
  strictEqual(await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: engaged.fetchImpl }).killSwitchEngaged(), false);
  const missing = fakeFetch(() => []);
  strictEqual(await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: missing.fetchImpl }).killSwitchEngaged(), true);
});

Deno.test("lists enabled subscriptions for the mode and maps them to camelCase with numeric fields", async () => {
  const fake = fakeFetch(() => [SUB_ROW]);
  const subs = await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: fake.fetchImpl }).listEnabledSubscriptions("live");
  strictEqual(fake.calls[0]?.path, "/rest/v1/position_subscriptions?select=*&mode=eq.live&enabled=eq.true&order=created_at.asc");
  deepStrictEqual(subs[0], {
    id: "sub-1",
    mode: "live",
    instId: "BTC-USDT-SWAP",
    posSide: "net",
    direction: "short",
    tdMode: "isolated",
    entryPx: 81818.5,
    slPx: 82700,
    tpPx: 80400,
    midPx: 82259.25,
    themeStopCapU: 0.1,
    atrLen: 14,
    atrMult: 0.8,
    amendMinAtrFrac: 0.15,
    halfReduceFrac: 0.5,
    dynamicTpEnabled: true,
    halfReduceEnabled: true,
    halfReduceDone: false,
    halfReduceAttempts: 2,
  });
});

Deno.test("eval writes PATCH the row with return=minimal and only the fields given", async () => {
  const fake = fakeFetch(() => undefined);
  await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: fake.fetchImpl }).recordEval("sub-1", {
    lastEvalAt: "2026-10-14T06:40:30.000Z",
    lastNote: "no_change",
  });
  const call = fake.calls[0];
  strictEqual(call?.method, "PATCH");
  strictEqual(call?.path, "/rest/v1/position_subscriptions?id=eq.sub-1");
  strictEqual(call?.headers.prefer, "return=minimal");
  deepStrictEqual(call?.body, { last_eval_at: "2026-10-14T06:40:30.000Z", last_note: "no_change" });
});

Deno.test("an amend eval also records the TP and the amend time", async () => {
  const fake = fakeFetch(() => undefined);
  await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: fake.fetchImpl }).recordEval("sub-1", {
    lastEvalAt: "2026-10-14T06:40:30.000Z",
    lastNote: "amend_acked",
    lastAmendAt: "2026-10-14T06:40:30.000Z",
    tpPx: 81810.5,
  });
  deepStrictEqual(fake.calls[0]?.body, {
    last_eval_at: "2026-10-14T06:40:30.000Z",
    last_note: "amend_acked",
    last_amend_at: "2026-10-14T06:40:30.000Z",
    tp_px: 81810.5,
  });
});

Deno.test("the half-way lease goes through the claim RPC and reports only a granted claim as true", async () => {
  const granted = fakeFetch(() => true);
  strictEqual(await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: granted.fetchImpl }).claimHalfReduce("sub-1", 300), true);
  deepStrictEqual(granted.calls[0]?.body, { p_id: "sub-1", p_lease_seconds: 300 });
  strictEqual(granted.calls[0]?.path, "/rest/v1/rpc/hive_position_claim_half_reduce");

  const held = fakeFetch(() => false);
  strictEqual(await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: held.fetchImpl }).claimHalfReduce("sub-1", 300), false);
});

Deno.test("finishing the reduce sends the outcome to the finish RPC", async () => {
  const fake = fakeFetch(() => undefined);
  await createRestPositionStore({ supabaseUrl: BASE, serviceKey: "k", fetchImpl: fake.fetchImpl }).finishHalfReduce("sub-1", {
    done: true,
    note: "half_reduce_acked:0.25:ord-1",
    reduced: true,
  });
  strictEqual(fake.calls[0]?.path, "/rest/v1/rpc/hive_position_finish_half_reduce");
  deepStrictEqual(fake.calls[0]?.body, { p_id: "sub-1", p_done: true, p_note: "half_reduce_acked:0.25:ord-1", p_reduced: true });
});
