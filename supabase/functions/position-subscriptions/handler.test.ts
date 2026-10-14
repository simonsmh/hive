import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { createPositionSubscriptionsHandler, MAX_BODY_BYTES, type SubscriptionStore, toUpsertRow } from "./handler.ts";
import type { PositionMode } from "./core/position.ts";

const TOKEN = "hive-order-token-test";

const BTC_SEED = {
  mode: "live",
  instId: "BTC-USDT-SWAP",
  posSide: "net",
  direction: "short",
  tdMode: "isolated",
  lever: 15,
  entryPx: 81818.5,
  slPx: 82700,
  tpPx: 80400,
  midPx: 82259.25,
  themeStopCapU: 0.1,
};

const QQQ_SEED = {
  mode: "live",
  instId: "QQQ-USDT-SWAP",
  posSide: "net",
  direction: "long",
  tdMode: "isolated",
  lever: 15,
  entryPx: 731.19,
  slPx: 721,
  tpPx: 741,
  midPx: 726.095,
  themeStopCapU: 0.1,
};

interface FakeStore extends SubscriptionStore {
  upserts: Record<string, unknown>[];
  lists: PositionMode[];
}

function fakeStore(options: { fail?: boolean; id?: string | null } = {}): FakeStore {
  const upserts: Record<string, unknown>[] = [];
  const lists: PositionMode[] = [];
  return {
    upserts,
    lists,
    async upsert(row) {
      if (options.fail) throw new Error("PostgREST POST /rest/v1/rpc/hive_position_subscription_upsert returned HTTP 500");
      upserts.push(row);
      return options.id === undefined ? "00000000-0000-4000-8000-000000000001" : options.id;
    },
    async list(mode) {
      lists.push(mode);
      return [{ inst_id: "QQQ-USDT-SWAP", mode, enabled: true }];
    },
  };
}

function setup(store: FakeStore = fakeStore(), token: string | undefined = TOKEN) {
  return createPositionSubscriptionsHandler({ orderToken: token, store, log: () => {} });
}

function post(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://hive.test/functions/v1/position-subscriptions", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

Deno.test("rejects requests without the order token", async () => {
  const store = fakeStore();
  const response = await setup(store)(post(BTC_SEED, "wrong"));
  strictEqual(response.status, 401);
  strictEqual(store.upserts.length, 0);
});

Deno.test("refuses everything when HIVE_ORDER_TOKEN is not configured", async () => {
  const handler = createPositionSubscriptionsHandler({ orderToken: undefined, store: fakeStore(), log: () => {} });
  const response = await handler(post(BTC_SEED, "anything"));
  strictEqual(response.status, 500);
});

Deno.test("rejects methods other than GET and POST", async () => {
  const response = await setup()(new Request("https://hive.test/", { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` } }));
  strictEqual(response.status, 405);
});

Deno.test("registers the BTC short seed with the table's snake_case columns and no reset", async () => {
  const store = fakeStore();
  const response = await setup(store)(post(BTC_SEED));
  strictEqual(response.status, 200);
  const body = await json(response);
  strictEqual(body.status, "upserted");
  strictEqual(body.instId, "BTC-USDT-SWAP");
  strictEqual(body.resetState, false);
  deepStrictEqual(store.upserts[0], {
    mode: "live",
    inst_id: "BTC-USDT-SWAP",
    pos_side: "net",
    direction: "short",
    td_mode: "isolated",
    lever: 15,
    entry_px: 81818.5,
    sl_px: 82700,
    tp_px: 80400,
    mid_px: 82259.25,
    theme: null,
    theme_stop_cap_u: 0.1,
    atr_len: 14,
    atr_mult: 0.8,
    amend_min_atr_frac: 0.15,
    half_reduce_frac: 0.5,
    dynamic_tp_enabled: true,
    half_reduce_enabled: true,
    enabled: true,
    reset_state: false,
    note: null,
  });
});

Deno.test("registers QQQ with no symbol allowlist in the way", async () => {
  const store = fakeStore();
  const response = await setup(store)(post(QQQ_SEED));
  strictEqual(response.status, 200);
  strictEqual(store.upserts[0]?.inst_id, "QQQ-USDT-SWAP");
  strictEqual(store.upserts[0]?.direction, "long");
});

Deno.test("accepts any USDT swap, not only the four original majors", async () => {
  const response = await setup()(post({ ...QQQ_SEED, instId: "DOGE-USDT-SWAP" }));
  strictEqual(response.status, 200);
});

Deno.test("rejects a non-USDT-margined instrument", async () => {
  const response = await setup()(post({ ...QQQ_SEED, instId: "BTC-USD-SWAP" }));
  strictEqual(response.status, 400);
  match(String((await json(response)).error), /USDT-margined swap/);
});

Deno.test("rejects geometry that does not match the side", async () => {
  const response = await setup()(post({ ...BTC_SEED, slPx: 81000 }));
  strictEqual(response.status, 400);
  match(String((await json(response)).error), /short needs slPx/);
});

Deno.test("rejects a theme stop cap above 0.1", async () => {
  const response = await setup()(post({ ...BTC_SEED, themeStopCapU: 0.2 }));
  strictEqual(response.status, 400);
});

Deno.test("rejects a midpoint outside entry and stop", async () => {
  const response = await setup()(post({ ...BTC_SEED, midPx: 83000 }));
  strictEqual(response.status, 400);
});

Deno.test("derives the midpoint from entry and stop when it is omitted", async () => {
  const store = fakeStore();
  const response = await setup(store)(post({ ...QQQ_SEED, midPx: undefined }));
  strictEqual(response.status, 200);
  strictEqual(store.upserts[0]?.mid_px, 726.095);
});

Deno.test("disabling returns the id that was disabled, or null when nothing was enabled", async () => {
  const store = fakeStore({ id: null });
  const response = await setup(store)(post({ ...BTC_SEED, enabled: false }));
  strictEqual(response.status, 200);
  const body = await json(response);
  strictEqual(body.status, "disabled");
  strictEqual(body.id, null);
  strictEqual(store.upserts[0]?.enabled, false);
});

Deno.test("reset_state is passed through only when asked for", async () => {
  const store = fakeStore();
  const response = await setup(store)(post({ ...BTC_SEED, resetState: true }));
  strictEqual(response.status, 200);
  strictEqual(store.upserts[0]?.reset_state, true);
});

Deno.test("rejects invalid JSON and oversized bodies", async () => {
  strictEqual((await setup()(post("{not json"))).status, 400);
  const oversized = JSON.stringify({ ...BTC_SEED, note: "x".repeat(MAX_BODY_BYTES) });
  strictEqual((await setup()(post(oversized))).status, 413);
});

Deno.test("store failures return 500 and never report success", async () => {
  const response = await setup(fakeStore({ fail: true }))(post(BTC_SEED));
  strictEqual(response.status, 500);
  strictEqual((await json(response)).status, "store_unavailable");
});

Deno.test("GET lists enabled subscriptions for the requested mode, default live", async () => {
  const store = fakeStore();
  const handler = setup(store);
  const live = await handler(new Request("https://hive.test/functions/v1/position-subscriptions", { headers: { authorization: `Bearer ${TOKEN}` } }));
  strictEqual(live.status, 200);
  strictEqual((await json(live)).mode, "live");
  const demo = await handler(new Request("https://hive.test/functions/v1/position-subscriptions?mode=demo", { headers: { authorization: `Bearer ${TOKEN}` } }));
  strictEqual((await json(demo)).mode, "demo");
  deepStrictEqual(store.lists, ["live", "demo"]);
});

Deno.test("GET needs the token and a valid mode", async () => {
  const handler = setup();
  strictEqual((await handler(new Request("https://hive.test/functions/v1/position-subscriptions"))).status, 401);
  const badMode = await handler(
    new Request("https://hive.test/functions/v1/position-subscriptions?mode=paper", { headers: { authorization: `Bearer ${TOKEN}` } }),
  );
  strictEqual(badMode.status, 400);
});

Deno.test("toUpsertRow maps every parsed field to its column", () => {
  const row = toUpsertRow({
    mode: "live",
    instId: "QQQ-USDT-SWAP",
    posSide: "long",
    direction: "long",
    tdMode: "cross",
    lever: 10,
    entryPx: 731.19,
    slPx: 721,
    tpPx: 741,
    midPx: 726.095,
    themeStopCapU: 0.05,
    theme: "qqq_breakout",
    atrLen: 20,
    atrMult: 1,
    amendMinAtrFrac: 0.2,
    halfReduceFrac: 0.4,
    dynamicTpEnabled: false,
    halfReduceEnabled: false,
    enabled: true,
    resetState: false,
    note: "seeded by hand",
  });
  strictEqual(row.inst_id, "QQQ-USDT-SWAP");
  strictEqual(row.pos_side, "long");
  strictEqual(row.td_mode, "cross");
  strictEqual(row.theme, "qqq_breakout");
  strictEqual(row.atr_len, 20);
  strictEqual(row.half_reduce_frac, 0.4);
  strictEqual(row.dynamic_tp_enabled, false);
  strictEqual(row.half_reduce_enabled, false);
  strictEqual(row.note, "seeded by hand");
});
