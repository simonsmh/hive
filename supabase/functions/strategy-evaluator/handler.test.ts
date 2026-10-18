import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import {
  createStrategyEvaluatorHandler,
  type AlertInsert,
  type ConditionalOrderRow,
  type OrderPatch,
  type OrderSubmitter,
  type StrategyStore,
  type SubmitOutcome,
} from "./handler.ts";

const CRON = "cron-secret-test";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const LOW_TS = Date.parse("2026-10-14T00:00:00.000Z");

function bar(ts: number, open: number, high: number, low: number, close: number): Candle {
  return { ts, open, high, low, close, volume: 1000, volCcy: 1000, confirmed: true };
}

/** Rise to ~110, capitulate to a 96 low on LOW_TS, hover, and (optionally) break out on the last bar. */
function series(breakout: boolean): Candle[] {
  const bars: Candle[] = [];
  let ts = LOW_TS - 51 * DAY;
  for (let i = 0; i < 45; i += 1) {
    const close = 100 + 10 * (i / 44);
    bars.push(bar(ts, close - 0.4, close + 0.6, close - 0.6, close));
    ts += DAY;
  }
  const steps = [106, 103, 100.5, 98.6, 97.4, 96.8];
  for (const close of steps) {
    bars.push(bar(ts, close + 1, close + 1.2, close === 96.8 ? 96 : close - 0.5, close));
    ts += DAY;
  }
  // ts is now LOW_TS + 1 day.
  bars.push(bar(ts, 97, 97.8, 96.4, 97.5));
  bars.push(bar(ts + DAY, 97.5, 98.4, 97, 98));
  bars.push(bar(ts + 2 * DAY, 98, 98.6, 97.4, 98.2));
  if (breakout) bars.push(bar(ts + 3 * DAY, 98.4, 99.8, 98.1, 99.5));
  return bars;
}

const BASE_ORDER: ConditionalOrderRow = {
  id: "ord-1",
  mode: "live",
  instId: "NVDA-USDT-SWAP",
  symbol: "NVDA",
  template: "reversal_long",
  posSide: "net",
  tdMode: "isolated",
  lever: 3,
  sz: "0.01",
  theme: "reversal-oct",
  themeStopCapU: 0.1,
  tpPct: null,
  params: {},
  status: "armed",
  setupLow: null,
  setupLowTs: null,
  drawdownPct: null,
  invalidations: 0,
  expiresAtMs: NOW + 10 * DAY,
};

interface FakeState {
  patches: { id: string; patch: OrderPatch }[];
  alerts: AlertInsert[];
  claims: string[];
  intents: Record<string, unknown>[];
}

function fakeStore(
  orders: ConditionalOrderRow[],
  daily: Candle[],
  state: FakeState,
  kill = false,
  getOrderImpl?: (id: string) => ConditionalOrderRow | null,
): StrategyStore {
  return {
    killSwitchEngaged: () => Promise.resolve(kill),
    listActiveOrders: () => Promise.resolve(orders),
    confirmedCandles: (_symbol, interval) => Promise.resolve(interval === "1D" ? daily : []),
    recordEval: (id, patch) => {
      state.patches.push({ id, patch });
      return Promise.resolve();
    },
    claim: (id) => {
      state.claims.push(id);
      return Promise.resolve(true);
    },
    getOrder: (id) => Promise.resolve(getOrderImpl ? getOrderImpl(id) : (orders.find((o) => o.id === id) ?? null)),
    insertAlert: (alert) => {
      state.alerts.push(alert);
      return Promise.resolve();
    },
  };
}

function makeHandler(
  store: StrategyStore,
  state: FakeState,
  outcome: SubmitOutcome,
  overrides: Partial<Parameters<typeof createStrategyEvaluatorHandler>[0]> = {},
) {
  const submitter: OrderSubmitter = {
    submit: (intent) => {
      state.intents.push(intent);
      return Promise.resolve(outcome);
    },
  };
  return createStrategyEvaluatorHandler({
    cronSecret: CRON,
    mode: "live",
    liveEnabled: true,
    dryRun: false,
    store,
    exchange: { instrumentSpec: () => Promise.resolve({ ctVal: 1, lotSz: 0.01, minSz: 0.01, tickSz: 0.01 }) },
    submitter,
    now: () => NOW,
    newIntentId: () => "co-test-1",
    log: () => {},
    ...overrides,
  });
}

function request(): Request {
  return new Request("https://example.test/strategy-evaluator", {
    method: "POST",
    headers: { authorization: `Bearer ${CRON}` },
  });
}

const ACKED: SubmitOutcome = { httpStatus: 200, status: "acked", reason: null, ordId: "ord-okx-1", algoId: "algo-1", detail: null };

Deno.test("primes an armed order on the capitulation series without submitting", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const handler = makeHandler(fakeStore([BASE_ORDER], series(false), state), state, ACKED);
  const response = await handler(request());
  strictEqual(response.status, 200);
  const body = await response.json();
  strictEqual(body.reports[0].action, "primed");
  strictEqual(state.intents.length, 0);
  strictEqual(state.patches.length, 1);
  strictEqual(state.patches[0]!.patch.status, "primed");
  strictEqual(state.patches[0]!.patch.setupLow, 96);
});

Deno.test("fires a primed order on the breakout bar and records the fill", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const primed: ConditionalOrderRow = {
    ...BASE_ORDER,
    status: "primed",
    setupLow: 96,
    setupLowTs: LOW_TS,
    drawdownPct: 13.2,
  };
  const handler = makeHandler(fakeStore([primed], series(true), state), state, ACKED);
  const response = await handler(request());
  const body = await response.json();
  strictEqual(body.reports[0].action, "fired");
  deepStrictEqual(state.claims, ["ord-1"]);
  strictEqual(state.intents.length, 1);
  const intent = state.intents[0]!;
  strictEqual(intent.action, "open");
  strictEqual(intent.side, "buy");
  strictEqual(intent.sz, "0.01");
  strictEqual(intent.slTriggerPx, "94.56"); // 96 * (1 - 1.5%)
  strictEqual(intent.theme, "reversal-oct");
  strictEqual(state.patches[0]!.patch.status, "fired");
  strictEqual(state.patches[0]!.patch.ordId, "ord-okx-1");
  strictEqual(state.alerts.length, 1);
  strictEqual(state.alerts[0]!.kind, "conditional_order_fired");
  strictEqual(state.alerts[0]!.severity, "critical");
});

Deno.test("aborts the fire when the order was cancelled after the claim", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const primed: ConditionalOrderRow = {
    ...BASE_ORDER,
    status: "primed",
    setupLow: 96,
    setupLowTs: LOW_TS,
    drawdownPct: 13.2,
  };
  const cancelled: ConditionalOrderRow = { ...primed, status: "cancelled" };
  const store = fakeStore([primed], series(true), state, false, () => cancelled);
  const handler = makeHandler(store, state, ACKED);
  const response = await handler(request());
  const body = await response.json();
  strictEqual(body.reports[0].action, "none");
  ok(body.reports[0].notes.join(" ").includes("fire_aborted"));
  deepStrictEqual(state.claims, ["ord-1"]);
  strictEqual(state.intents.length, 0);
  strictEqual(state.alerts.length, 0);
});

Deno.test("fails the order when order-submit rejects before placing anything", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const primed: ConditionalOrderRow = { ...BASE_ORDER, status: "primed", setupLow: 96, setupLowTs: LOW_TS, drawdownPct: 13.2 };
  const rejected: SubmitOutcome = { httpStatus: 422, status: "rejected_risk", reason: "notional_exceeds_limit", ordId: null, algoId: null, detail: null };
  const handler = makeHandler(fakeStore([primed], series(true), state), state, rejected);
  const body = await (await handler(request())).json();
  strictEqual(body.reports[0].action, "failed");
  ok(body.reports[0].notes.join(" ").includes("fire_rejected:rejected_risk:notional_exceeds_limit"));
  strictEqual(state.alerts[0]!.kind, "conditional_order_failed");
});

Deno.test("resets a primed order when a daily close breaks the stop level, then re-primes on the deeper low", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const primed: ConditionalOrderRow = { ...BASE_ORDER, status: "primed", setupLow: 96, setupLowTs: LOW_TS, drawdownPct: 13.2 };
  const broken = series(false);
  const lastTs = broken[broken.length - 1]!.ts;
  broken.push(bar(lastTs + DAY, 95, 95.4, 93.8, 94.1)); // close 94.1 < 94.56 stop level; its low is the new capitulation low
  const handler = makeHandler(fakeStore([primed], broken, state), state, ACKED);
  const body = await (await handler(request())).json();
  strictEqual(body.reports[0].action, "reset");
  strictEqual(state.intents.length, 0);
  strictEqual(state.patches[0]!.patch.invalidations, 1);
  // The broken setup is discarded; the same run primes a fresh one on the deeper low, still unfilled.
  strictEqual(state.patches[0]!.patch.status, "primed");
  strictEqual(state.patches[0]!.patch.setupLow, 93.8);
});

Deno.test("expires an order past its expiry without evaluating", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const expired: ConditionalOrderRow = { ...BASE_ORDER, expiresAtMs: NOW - 1000 };
  const handler = makeHandler(fakeStore([expired], series(true), state), state, ACKED);
  const body = await (await handler(request())).json();
  strictEqual(body.reports[0].action, "expired");
  strictEqual(state.patches[0]!.patch.status, "expired");
  strictEqual(state.intents.length, 0);
});

Deno.test("dry run reports the fire but never claims, submits or records", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const primed: ConditionalOrderRow = { ...BASE_ORDER, status: "primed", setupLow: 96, setupLowTs: LOW_TS, drawdownPct: 13.2 };
  const handler = makeHandler(fakeStore([primed], series(true), state), state, ACKED, { dryRun: true });
  const body = await (await handler(request())).json();
  ok(body.reports[0].notes.join(" ").includes("dry_run:fire:breakout"));
  strictEqual(state.claims.length, 0);
  strictEqual(state.intents.length, 0);
  strictEqual(state.patches.length, 0);
});

Deno.test("kill switch skips the whole run", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const handler = makeHandler(fakeStore([BASE_ORDER], series(true), state, true), state, ACKED);
  const body = await (await handler(request())).json();
  strictEqual(body.status, "skipped");
  strictEqual(body.reason, "kill_switch_engaged");
  strictEqual(state.patches.length, 0);
});

Deno.test("rejects requests without the cron secret", async () => {
  const state: FakeState = { patches: [], alerts: [], claims: [], intents: [] };
  const handler = makeHandler(fakeStore([BASE_ORDER], series(true), state), state, ACKED);
  const response = await handler(new Request("https://example.test/strategy-evaluator", { method: "POST" }));
  strictEqual(response.status, 401);
});
