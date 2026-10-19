import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { AlgoDetail, OrderDetail } from "./core/okx-trade.ts";
import type { PendingAlgo, PositionRow } from "./core/position.ts";
import {
  createOrderSyncHandler,
  type OrderRow,
  type OrderSyncExchange,
  type OrderSyncPatch,
  type OrderSyncStore,
} from "./handler.ts";

const CRON = "cron-secret-test";
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 1,
    kind: "order",
    instId: "NVDA-USDT-SWAP",
    ordId: "ord-1",
    algoId: null,
    state: "accepted",
    fillPx: null,
    fillSz: null,
    ...overrides,
  };
}

function fakeStore(rows: OrderRow[]) {
  const patches: { id: number; patch: OrderSyncPatch }[] = [];
  const store: OrderSyncStore = {
    listPending: () => Promise.resolve(rows),
    applySync: (id, patch) => {
      patches.push({ id, patch });
      return Promise.resolve();
    },
  };
  return { store, patches };
}

function fakeExchange(overrides: Partial<OrderSyncExchange> = {}) {
  const exchange: OrderSyncExchange = {
    orderDetail: () => Promise.resolve<OrderDetail | null>({ ordId: "ord-1", state: "filled", avgPx: 219.48, accFillSz: 0.01 }),
    algoDetail: () => Promise.resolve<AlgoDetail | null>({ algoId: "algo-1", state: "live", actualPx: null, actualSz: 0 }),
    positions: () => Promise.resolve<PositionRow[]>([]),
    pendingAlgos: () => Promise.resolve<PendingAlgo[]>([]),
    ...overrides,
  };
  return exchange;
}

function handler(store: OrderSyncStore, exchange: OrderSyncExchange) {
  return createOrderSyncHandler({ cronSecret: CRON, mode: "live", store, exchange, now: () => NOW });
}

function request(method: string, path = "https://edge/order-sync", secret: string | null = CRON): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return new Request(path, { method, headers });
}

Deno.test("rejects requests without the cron secret", async () => {
  const { store } = fakeStore([]);
  const response = await handler(store, fakeExchange())(request("POST", "https://edge/order-sync", null));
  strictEqual(response.status, 401);
});

Deno.test("fails closed when the cron secret is not configured", async () => {
  const { store } = fakeStore([]);
  const unconfigured = createOrderSyncHandler({ cronSecret: undefined, mode: "live", store, exchange: fakeExchange(), now: () => NOW });
  const response = await unconfigured(request("POST"));
  strictEqual(response.status, 500);
});

Deno.test("backfills state and fill for a filled order", async () => {
  const { store, patches } = fakeStore([orderRow()]);
  const response = await handler(store, fakeExchange())(request("POST"));
  strictEqual(response.status, 200);
  deepStrictEqual(await response.json(), {
    status: "ok",
    mode: "live",
    checked: 1,
    updated: 1,
    missing: 0,
    failed: 0,
    error: null,
  });
  deepStrictEqual(patches, [{ id: 1, patch: { lastSyncAt: NOW_ISO, state: "filled", fillSz: 0.01, fillPx: 219.48 } }]);
});

Deno.test("leaves fill columns untouched while an order is still live", async () => {
  const { store, patches } = fakeStore([orderRow({ state: "live" })]);
  const exchange = fakeExchange({
    orderDetail: () => Promise.resolve<OrderDetail | null>({ ordId: "ord-1", state: "live", avgPx: null, accFillSz: 0 }),
  });
  const response = await handler(store, exchange)(request("POST"));
  strictEqual(response.status, 200);
  deepStrictEqual(patches, [{ id: 1, patch: { lastSyncAt: NOW_ISO } }]);
});

Deno.test("counts an order OKX no longer knows as missing and only bumps last_sync_at", async () => {
  const { store, patches } = fakeStore([orderRow()]);
  const exchange = fakeExchange({ orderDetail: () => Promise.resolve(null) });
  const response = await handler(store, exchange)(request("POST"));
  const body = await response.json();
  strictEqual(body.missing, 1);
  strictEqual(body.updated, 0);
  deepStrictEqual(patches, [{ id: 1, patch: { lastSyncAt: NOW_ISO } }]);
});

Deno.test("syncs algo order state without touching fill columns", async () => {
  const { store, patches } = fakeStore([
    orderRow({ id: 2, kind: "algo", ordId: null, algoId: "algo-1", state: "accepted" }),
  ]);
  const exchange = fakeExchange({
    algoDetail: () => Promise.resolve<AlgoDetail | null>({ algoId: "algo-1", state: "effective", actualPx: null, actualSz: 0 }),
  });
  const response = await handler(store, exchange)(request("POST"));
  strictEqual(response.status, 200);
  deepStrictEqual(patches, [{ id: 2, patch: { lastSyncAt: NOW_ISO, state: "effective" } }]);
});

Deno.test("backfills the execution price and size when an algo triggers", async () => {
  const { store, patches } = fakeStore([
    orderRow({ id: 3, kind: "algo", ordId: null, algoId: "algo-9", state: "live" }),
  ]);
  const exchange = fakeExchange({
    algoDetail: () => Promise.resolve<AlgoDetail | null>({ algoId: "algo-9", state: "effective", actualPx: 209.15, actualSz: 0.01 }),
  });
  const response = await handler(store, exchange)(request("POST"));
  strictEqual(response.status, 200);
  deepStrictEqual(patches, [{ id: 3, patch: { lastSyncAt: NOW_ISO, state: "effective", fillSz: 0.01, fillPx: 209.15 } }]);
});

Deno.test("one failing row does not stop the sweep", async () => {
  const { store, patches } = fakeStore([orderRow(), orderRow({ id: 2, ordId: "ord-2" })]);
  const exchange = fakeExchange({
    orderDetail: (_instId, ordId) =>
      ordId === "ord-1"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve<OrderDetail | null>({ ordId: "ord-2", state: "canceled", avgPx: null, accFillSz: 0 }),
  });
  const response = await handler(store, exchange)(request("POST"));
  const body = await response.json();
  strictEqual(body.checked, 2);
  strictEqual(body.failed, 1);
  strictEqual(body.updated, 1);
  strictEqual(body.error, "boom");
  strictEqual(patches.length, 1);
});

Deno.test("GET returns the live position and pending algos for an instrument", async () => {
  const { store } = fakeStore([]);
  const exchange = fakeExchange({
    positions: () => Promise.resolve<PositionRow[]>([{ posSide: "net", pos: 0.01, avgPx: 219.48, markPx: 217.5 }]),
    pendingAlgos: () =>
      Promise.resolve<PendingAlgo[]>([
        {
          algoId: "algo-1",
          algoClOrdId: "ac-1",
          side: "sell",
          posSide: "net",
          sz: 0.01,
          reduceOnly: true,
          slTriggerPx: "209.15",
          slOrdPx: "-1",
          tpTriggerPx: null,
          tpOrdPx: null,
        },
      ]),
  });
  const response = await handler(store, exchange)(request("GET", "https://edge/order-sync?instId=NVDA-USDT-SWAP"));
  strictEqual(response.status, 200);
  const body = await response.json();
  strictEqual(body.instId, "NVDA-USDT-SWAP");
  strictEqual(body.positions[0].avgPx, 219.48);
  strictEqual(body.algos[0].slTriggerPx, "209.15");
});

Deno.test("GET rejects a malformed instId", async () => {
  const { store } = fakeStore([]);
  const response = await handler(store, fakeExchange())(request("GET", "https://edge/order-sync?instId=foo"));
  strictEqual(response.status, 400);
});
