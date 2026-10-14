import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { OkxTradeError, type OrderTrade, type PlacedAlgo, type PlacedOrder } from "./core/okx-trade.ts";
import type { RiskLimitsView, TradeMode } from "./core/order-intent.ts";
import {
  type InsertResult,
  type IntentOutcome,
  type IntentRecord,
  createOrderSubmitHandler,
  type OrderRecord,
  type OrderStore,
  type StoredIntent,
} from "./handler.ts";

const TOKEN = "hive-order-token-test";
const NOW = Date.parse("2026-10-14T06:40:30.000Z");
const LIMITS: RiskLimitsView = {
  symbolAllowlist: ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "XAU-USDT-SWAP"],
  maxNotionalUsdt: 500,
  maxLeverage: 20,
  maxOrdersPerMin: 5,
};

const GROK_SHORT = {
  schema: "okx.intent.v1",
  intentId: "int-20261014-0001",
  idempotencyKey: "grok-xau-cpi-short-0001",
  action: "open",
  instId: "XAU-USDT-SWAP",
  side: "sell",
  posSide: "net",
  tdMode: "isolated",
  lever: 15,
  sz: "1",
  ordType: "market",
  px: null,
  reduceOnly: false,
  slTriggerPx: "4125",
  slOrdPx: "-1",
  tpTriggerPx: "4085",
  tpOrdPx: "-1",
  theme: "xau_cpi",
  themeStopCapU: 0.1,
  maxLossU: 0.1,
  reason: "short after hot CPI",
  source: "grok",
  createdAt: "2026-10-14T14:40:00+08:00",
  ttlSec: 120,
};

/** Simulated clock. NOW is 2026-10-14T06:40:30Z; the sample intent was created at 06:40:00Z. */
class Clock {
  nowMs: number;
  constructor(nowMs: number) {
    this.nowMs = nowMs;
  }
  now = (): number => this.nowMs;
}

interface StoreOptions {
  limits?: RiskLimitsView | null;
  killSwitch?: boolean;
  submissions?: number;
  insertFails?: boolean;
  subscribed?: boolean;
}

function fakeStore(options: StoreOptions, clock: Clock) {
  const intents = new Map<string, StoredIntent & { intentId: string }>();
  const finished: { key: string; outcome: IntentOutcome }[] = [];
  const orders: OrderRecord[] = [];
  const algoStates: Record<string, string> = {};
  const subscriptionLookups: string[] = [];
  let liveAlgoRows: { algoId: string; clOrdId: string }[] = [];
  const store: OrderStore = {
    async killSwitchEngaged() {
      return options.killSwitch ?? false;
    },
    async riskLimits(_mode: TradeMode) {
      return options.limits === undefined ? LIMITS : options.limits;
    },
    async insertIntent(record: IntentRecord): Promise<InsertResult> {
      if (options.insertFails) throw new Error("PostgREST rpc/hive_order_intent_insert returned HTTP 503");
      const existing = intents.get(record.idempotencyKey);
      if (existing) return { inserted: false, existing };
      const intentIdTaken = [...intents.values()].some((row) => row.intentId === record.intentId);
      if (intentIdTaken) return { inserted: false, existing: null };
      intents.set(record.idempotencyKey, {
        intentId: record.intentId,
        status: "received",
        reason: null,
        ordId: null,
        algoId: null,
        clOrdId: record.clOrdId,
        state: null,
        detail: null,
        receivedAtMs: clock.now(),
      });
      return { inserted: true };
    },
    async finishIntent(key, outcome) {
      finished.push({ key, outcome });
      const row = intents.get(key);
      if (row) Object.assign(row, { status: outcome.status, reason: outcome.reason, ordId: outcome.ordId, algoId: outcome.algoId, detail: outcome.detail });
    },
    async submissionsSince() {
      return options.submissions ?? 0;
    },
    async hasEnabledSubscription(_mode: TradeMode, instId: string) {
      subscriptionLookups.push(instId);
      return options.subscribed ?? false;
    },
    async recordOrder(record) {
      orders.push(record);
    },
    async liveAlgos() {
      return liveAlgoRows;
    },
    async setOrderState(clOrdId, state) {
      algoStates[clOrdId] = state;
    },
  };
  return {
    store,
    finished,
    orders,
    algoStates,
    subscriptionLookups,
    setLiveAlgos(rows: { algoId: string; clOrdId: string }[]) {
      liveAlgoRows = rows;
    },
  };
}

interface TradeOptions {
  lastPrice?: number;
  ctVal?: number;
  position?: { avgPx: number } | null;
  placeOrder?: () => Promise<PlacedOrder>;
  placeAlgo?: () => Promise<PlacedAlgo>;
  setLeverage?: () => Promise<void>;
  cancelAlgos?: (items: { algoId: string; instId: string }[]) => Promise<void>;
  findOrderByClOrdId?: () => Promise<{ ordId: string; state: string } | null>;
}

function fakeTrade(options: TradeOptions = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const trade: OrderTrade = {
    async lastPrice(instId) {
      calls.push({ method: "lastPrice", args: instId });
      return options.lastPrice ?? 4107;
    },
    async contractValue(instId) {
      calls.push({ method: "contractValue", args: instId });
      return options.ctVal ?? 0.001;
    },
    async position(instId) {
      calls.push({ method: "position", args: instId });
      return options.position === undefined ? null : options.position;
    },
    async setLeverage(instId, lever, tdMode) {
      calls.push({ method: "setLeverage", args: { instId, lever, tdMode } });
      await options.setLeverage?.();
    },
    async placeOrder(body) {
      calls.push({ method: "placeOrder", args: body });
      return options.placeOrder ? options.placeOrder() : { ordId: "2456789012345678901", clOrdId: String(body.clOrdId) };
    },
    async placeAlgo(body) {
      calls.push({ method: "placeAlgo", args: body });
      return options.placeAlgo ? options.placeAlgo() : { algoId: "9988776655", algoClOrdId: String(body.algoClOrdId) };
    },
    async cancelAlgos(items) {
      calls.push({ method: "cancelAlgos", args: items });
      await options.cancelAlgos?.(items);
    },
    async findOrderByClOrdId(instId, clOrdId) {
      calls.push({ method: "findOrderByClOrdId", args: { instId, clOrdId } });
      return options.findOrderByClOrdId ? options.findOrderByClOrdId() : null;
    },
  };
  return { trade, calls, placed: () => calls.filter((c) => c.method === "placeOrder" || c.method === "placeAlgo") };
}

function setup(options: { mode?: TradeMode; liveEnabled?: boolean; store?: StoreOptions; trade?: TradeOptions; token?: string | undefined } = {}) {
  const clock = new Clock(NOW);
  const storeFake = fakeStore(options.store ?? {}, clock);
  const tradeFake = fakeTrade(options.trade);
  const handler = createOrderSubmitHandler({
    orderToken: "token" in options ? options.token : TOKEN,
    mode: options.mode ?? "demo",
    liveEnabled: options.liveEnabled ?? false,
    store: storeFake.store,
    trade: tradeFake.trade,
    now: clock.now,
    log: () => {},
  });
  return { handler, clock, ...storeFake, ...tradeFake };
}

function post(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://hive.test/functions/v1/order-submit", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

Deno.test("rejects non-POST methods", async () => {
  const { handler } = setup();
  const response = await handler(new Request("https://hive.test", { method: "GET" }));
  strictEqual(response.status, 405);
});

Deno.test("fails closed when HIVE_ORDER_TOKEN is not configured", async () => {
  const { handler, placed } = setup({ token: undefined });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 500);
  strictEqual(placed().length, 0);
});

Deno.test("rejects a missing or wrong bearer token without touching the store", async () => {
  const { handler, finished, placed } = setup();
  const missing = await handler(post(GROK_SHORT, null));
  strictEqual(missing.status, 401);
  strictEqual((await json(missing)).status, "rejected_auth");

  const wrong = await handler(post(GROK_SHORT, "not-the-token"));
  strictEqual(wrong.status, 401);
  strictEqual(finished.length, 0);
  strictEqual(placed().length, 0);
});

Deno.test("rejects non-JSON and schema-invalid bodies with 400", async () => {
  const { handler, placed } = setup();
  const notJson = await handler(post("{not json"));
  strictEqual(notJson.status, 400);
  strictEqual((await json(notJson)).reason, "body is not JSON");

  const wrongSchema = await handler(post({ ...GROK_SHORT, schema: "okx.intent.v2" }));
  strictEqual(wrongSchema.status, 400);
  ok(String((await json(wrongSchema)).reason).includes("schema"));
  strictEqual(placed().length, 0);
});

Deno.test("rejects live mode unless OKX_TRADE_LIVE_ENABLED is set, and never stores the attempt", async () => {
  const { handler, placed, finished, orders } = setup({ mode: "live", liveEnabled: false });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 422);
  const body = await json(response);
  strictEqual(body.status, "rejected_risk");
  strictEqual(body.reason, "live_disabled");
  strictEqual(placed().length, 0);
  strictEqual(finished.length, 0);
  strictEqual(orders.length, 0);
});

Deno.test("places a demo open: sets leverage, sends SL/TP attached to the order, returns the ordId", async () => {
  const { handler, calls, finished, orders } = setup();
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 200);
  const body = await json(response);
  strictEqual(body.status, "acked");
  strictEqual(body.ordId, "2456789012345678901");
  strictEqual(body.mode, "demo");
  strictEqual(body.intentId, "int-20261014-0001");
  strictEqual(body.state, "accepted");
  ok(typeof body.clOrdId === "string" && /^[a-z0-9]{32}$/.test(String(body.clOrdId)));

  const placeCall = calls.find((c) => c.method === "placeOrder");
  const sent = placeCall?.args as Record<string, unknown>;
  strictEqual(sent.instId, "XAU-USDT-SWAP");
  strictEqual(sent.side, "sell");
  strictEqual(sent.reduceOnly, false);
  strictEqual(sent.posSide, undefined);
  const attach = (sent.attachAlgoOrds as Record<string, unknown>[])[0];
  strictEqual(attach?.slTriggerPx, "4125");
  strictEqual(attach?.tpTriggerPx, "4085");

  const leverage = calls.find((c) => c.method === "setLeverage");
  deepStrictEqual(leverage?.args, { instId: "XAU-USDT-SWAP", lever: 15, tdMode: "isolated" });
  strictEqual(orders.length, 1);
  strictEqual(orders[0]?.ordId, "2456789012345678901");
  strictEqual(finished[0]?.outcome.status, "acked");
});

Deno.test("rejects an open without a stop loss before any OKX call", async () => {
  const { handler, calls, finished } = setup();
  const response = await handler(post({ ...GROK_SHORT, slTriggerPx: null, slOrdPx: null }));
  strictEqual(response.status, 422);
  const body = await json(response);
  strictEqual(body.status, "rejected_risk");
  strictEqual(body.reason, "missing_stop_loss");
  strictEqual(calls.length, 0);
  strictEqual(finished[0]?.outcome.status, "rejected_risk");
});

Deno.test("returns 423 when the kill switch is engaged", async () => {
  const { handler, calls } = setup({ store: { killSwitch: true } });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 423);
  strictEqual((await json(response)).reason, "kill_switch_engaged");
  strictEqual(calls.length, 0);
});

Deno.test("fails closed when no enabled risk limits exist for the mode", async () => {
  const { handler, calls } = setup({ store: { limits: null } });
  const response = await handler(post(GROK_SHORT));
  strictEqual((await json(response)).reason, "no_risk_limits");
  strictEqual(calls.length, 0);
});

Deno.test("rejects a symbol outside the allowlist", async () => {
  const { handler, calls } = setup();
  const response = await handler(post({ ...GROK_SHORT, instId: "DOGE-USDT-SWAP" }));
  strictEqual(response.status, 422);
  strictEqual((await json(response)).reason, "symbol_not_allowed");
  strictEqual(calls.length, 0);
});

const QQQ_REDUCE = {
  ...GROK_SHORT,
  intentId: "int-qqq-reduce",
  idempotencyKey: "pm-qqq-reduce-1",
  action: "reduce",
  instId: "QQQ-USDT-SWAP",
  side: "sell",
  reduceOnly: true,
  lever: null,
  sz: "3",
  ordType: "market",
  theme: null,
  themeStopCapU: null,
  maxLossU: null,
  slTriggerPx: null,
  slOrdPx: null,
  tpTriggerPx: null,
  tpOrdPx: null,
  source: "hive:position-manager",
};

Deno.test("reduce on an instrument outside the allowlist is placed when it has an enabled subscription", async () => {
  const { handler, calls, subscriptionLookups } = setup({ store: { subscribed: true } });
  const response = await handler(post(QQQ_REDUCE));
  strictEqual(response.status, 200);
  strictEqual((await json(response)).status, "acked");
  deepStrictEqual(subscriptionLookups, ["QQQ-USDT-SWAP"]);
  const order = calls.find((c) => c.method === "placeOrder")?.args as Record<string, unknown>;
  strictEqual(order.reduceOnly, true);
  strictEqual(order.instId, "QQQ-USDT-SWAP");
});

Deno.test("reduce outside the allowlist without a subscription is still refused, and places nothing", async () => {
  const { handler, calls } = setup({ store: { subscribed: false } });
  const response = await handler(post(QQQ_REDUCE));
  strictEqual(response.status, 422);
  strictEqual((await json(response)).reason, "symbol_not_allowed");
  strictEqual(calls.length, 0);
});

Deno.test("open outside the allowlist is refused even with an enabled subscription", async () => {
  const { handler, calls, subscriptionLookups } = setup({ store: { subscribed: true } });
  const response = await handler(post({ ...GROK_SHORT, instId: "QQQ-USDT-SWAP" }));
  strictEqual((await json(response)).reason, "symbol_not_allowed");
  strictEqual(subscriptionLookups.length, 0);
  strictEqual(calls.length, 0);
});

Deno.test("an allowlisted instrument does not query subscriptions", async () => {
  const { handler, subscriptionLookups } = setup({ store: { subscribed: false } });
  const response = await handler(post({ ...QQQ_REDUCE, instId: "BTC-USDT-SWAP", idempotencyKey: "pm-btc-reduce-1" }));
  strictEqual(response.status, 200);
  strictEqual(subscriptionLookups.length, 0);
});

Deno.test("rejects when the per-minute submission rate is reached", async () => {
  const { handler, calls } = setup({ store: { submissions: 5 } });
  const response = await handler(post(GROK_SHORT));
  strictEqual((await json(response)).reason, "rate_limited");
  strictEqual(calls.length, 0);
});

Deno.test("rejects a loss above themeStopCapU after pricing, and places nothing", async () => {
  const { handler, placed, finished } = setup({ trade: { lastPrice: 4107 } });
  const response = await handler(post({ ...GROK_SHORT, themeStopCapU: 0.01, maxLossU: null }));
  strictEqual(response.status, 422);
  strictEqual((await json(response)).reason, "loss_exceeds_theme_cap");
  strictEqual(placed().length, 0);
  strictEqual(finished[0]?.outcome.status, "rejected_risk");
});

Deno.test("rejects a notional above maxNotionalUsdt", async () => {
  const { handler, placed } = setup();
  const response = await handler(post({ ...GROK_SHORT, sz: "200000" }));
  strictEqual((await json(response)).reason, "notional_exceeds_limit");
  strictEqual(placed().length, 0);
});

Deno.test("returns expired when createdAt + ttlSec has passed", async () => {
  const { handler, placed } = setup({ store: {} });
  const stale = { ...GROK_SHORT, createdAt: "2026-10-14T14:30:00+08:00", ttlSec: 120 };
  const response = await handler(post(stale));
  strictEqual(response.status, 422);
  strictEqual((await json(response)).status, "expired");
  strictEqual(placed().length, 0);
});

Deno.test("a repeated idempotencyKey within 10 minutes returns the first result and never places a second order", async () => {
  const { handler, clock, placed } = setup();
  const first = await json(await handler(post(GROK_SHORT)));
  clock.nowMs = NOW + 5 * 60_000;
  const replayResponse = await handler(post({ ...GROK_SHORT, intentId: "int-retry" }));
  const replayBody = await json(replayResponse);

  strictEqual(replayResponse.status, 200);
  strictEqual(replayBody.duplicate, true);
  strictEqual(replayBody.ordId, first.ordId);
  strictEqual(replayBody.status, "acked");
  strictEqual(placed().length, 1);
});

Deno.test("a repeated key after 10 minutes returns 409 and places nothing", async () => {
  const { handler, clock, placed } = setup();
  await handler(post(GROK_SHORT));
  clock.nowMs = NOW + 11 * 60_000;
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 409);
  strictEqual((await json(response)).status, "duplicate_key_expired");
  strictEqual(placed().length, 1);
});

Deno.test("an intentId reused under a different key returns 409 and places nothing new", async () => {
  const { handler, placed } = setup();
  await handler(post(GROK_SHORT));
  const response = await handler(post({ ...GROK_SHORT, idempotencyKey: "another-key" }));
  strictEqual(response.status, 409);
  strictEqual((await json(response)).status, "duplicate_intent_id");
  strictEqual(placed().length, 1);
});

Deno.test("a key still in flight returns 409 in_progress", async () => {
  const clock = new Clock(NOW);
  const inFlight = fakeStore({}, clock);
  await inFlight.store.insertIntent({
    intentId: GROK_SHORT.intentId,
    idempotencyKey: GROK_SHORT.idempotencyKey,
    mode: "demo",
    schemaVersion: "okx.intent.v1",
    action: "open",
    source: "grok",
    instId: "XAU-USDT-SWAP",
    side: "sell",
    posSide: "net",
    tdMode: "isolated",
    lever: 15,
    sz: "1",
    ordType: "market",
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
    intentCreatedAt: GROK_SHORT.createdAt,
    ttlSec: 120,
    clOrdId: "h".repeat(32),
    request: {},
  });
  const tradeFake = fakeTrade();
  const handler = createOrderSubmitHandler({
    orderToken: TOKEN,
    mode: "demo",
    liveEnabled: false,
    store: inFlight.store,
    trade: tradeFake.trade,
    now: clock.now,
    log: () => {},
  });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 409);
  strictEqual((await json(response)).status, "in_progress");
  strictEqual(tradeFake.calls.length, 0);
});

Deno.test("an OKX element rejection returns exchange_error with the sCode and stores it", async () => {
  const { handler, finished } = setup({
    trade: {
      placeOrder: () => Promise.reject(new OkxTradeError("OKX order rejected (51008): Insufficient margin", "api", undefined, "51008")),
    },
  });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 502);
  const body = await json(response);
  strictEqual(body.status, "exchange_error");
  strictEqual(body.reason, "okx_rejected:51008");
  strictEqual(finished[0]?.outcome.status, "exchange_error");
});

Deno.test("a network failure on placement recovers the order by clOrdId when OKX has it", async () => {
  const { handler, orders } = setup({
    trade: {
      placeOrder: () => Promise.reject(new OkxTradeError("network error calling /api/v5/trade/order: timeout", "network")),
      findOrderByClOrdId: async () => ({ ordId: "555", state: "live" }),
    },
  });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 200);
  const body = await json(response);
  strictEqual(body.status, "acked");
  strictEqual(body.ordId, "555");
  strictEqual(body.detail, "recovered_after_network_error");
  strictEqual(orders.length, 1);
  strictEqual(orders[0]?.ordId, "555");
});

Deno.test("a network failure with no order at OKX reports outcome_unknown", async () => {
  const { handler } = setup({
    trade: {
      placeOrder: () => Promise.reject(new OkxTradeError("network error", "network")),
      findOrderByClOrdId: async () => null,
    },
  });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 502);
  strictEqual((await json(response)).reason, "outcome_unknown");
});

Deno.test("an OKX auth rejection returns rejected_auth and stores it", async () => {
  const { handler, finished } = setup({
    trade: {
      setLeverage: () => Promise.reject(new OkxTradeError("OKX invalid key", "api", "50111")),
    },
  });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 401);
  const body = await json(response);
  strictEqual(body.status, "rejected_auth");
  strictEqual(body.reason, "okx_auth:50111");
  strictEqual(finished[0]?.outcome.status, "rejected_auth");
});

Deno.test("a close is a reduce-only market order with no leverage call", async () => {
  const { handler, calls } = setup();
  const close = {
    ...GROK_SHORT,
    intentId: "int-close",
    idempotencyKey: "close-key-1",
    action: "close",
    side: "buy",
    reduceOnly: true,
    slTriggerPx: null,
    slOrdPx: null,
    tpTriggerPx: null,
    tpOrdPx: null,
    lever: null,
    theme: null,
    themeStopCapU: null,
  };
  const response = await handler(post(close));
  strictEqual(response.status, 200);
  strictEqual(calls.some((c) => c.method === "setLeverage"), false);
  const sent = calls.find((c) => c.method === "placeOrder")?.args as Record<string, unknown>;
  strictEqual(sent.reduceOnly, true);
  strictEqual(sent.attachAlgoOrds, undefined);
});

Deno.test("amend_tpsl places a reduce-only algo and cancels the previous Hive algo on the instrument", async () => {
  const { handler, calls, algoStates, setLiveAlgos } = setup({
    store: {},
    trade: { position: { avgPx: 4107 } },
  });
  setLiveAlgos([{ algoId: "111", clOrdId: "a".repeat(32) }]);
  const amend = {
    ...GROK_SHORT,
    intentId: "int-amend",
    idempotencyKey: "amend-key-1",
    action: "amend_tpsl",
    side: "buy",
    reduceOnly: true,
    lever: null,
    theme: null,
    themeStopCapU: null,
    maxLossU: null,
    slTriggerPx: "4125",
    slOrdPx: "-1",
    tpTriggerPx: null,
    tpOrdPx: null,
  };
  const response = await handler(post(amend));
  strictEqual(response.status, 200);
  const body = await json(response);
  strictEqual(body.algoId, "9988776655");
  ok(String(body.detail).includes("replaced_algo_ids=111"));

  const algo = calls.find((c) => c.method === "placeAlgo")?.args as Record<string, unknown>;
  strictEqual(algo.reduceOnly, true);
  strictEqual(algo.ordType, "conditional");
  const cancel = calls.find((c) => c.method === "cancelAlgos")?.args as { algoId: string; instId: string }[];
  deepStrictEqual(cancel, [{ algoId: "111", instId: "XAU-USDT-SWAP" }]);
  strictEqual(algoStates["a".repeat(32)], "canceled");
});

Deno.test("amend_tpsl with a cap rejects when there is no open position", async () => {
  const { handler, placed } = setup({ trade: { position: null } });
  const amend = {
    ...GROK_SHORT,
    intentId: "int-amend-flat",
    idempotencyKey: "amend-flat-1",
    action: "amend_tpsl",
    side: "buy",
    reduceOnly: true,
    lever: null,
    theme: null,
    slTriggerPx: "4125",
    slOrdPx: "-1",
    tpTriggerPx: null,
    tpOrdPx: null,
  };
  const response = await handler(post(amend));
  strictEqual(response.status, 422);
  strictEqual((await json(response)).reason, "no_position");
  strictEqual(placed().length, 0);
});

Deno.test("a store failure before placement returns 502 and places nothing", async () => {
  const { handler, placed } = setup({ store: { insertFails: true } });
  const response = await handler(post(GROK_SHORT));
  strictEqual(response.status, 502);
  strictEqual((await json(response)).reason, "store_unavailable");
  strictEqual(placed().length, 0);
});
