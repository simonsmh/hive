import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  buildCandidates,
  createPushNotifyHandler,
  parsePushFilters,
  type AlertRow,
  type NewsEventRow,
  type PushStore,
  type PushSubscriptionRow,
  type SendPushFunction,
} from "./handler.ts";
import type { PushSubscriptionKeys, VapidKeys } from "./core/webpush.ts";

const SECRET = "test-cron-secret";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const VAPID: VapidKeys = { publicKey: "pub", privateKey: "priv", subject: "mailto:ops@example.com" };

const SUB: PushSubscriptionRow = {
  id: "sub-1",
  endpoint: "https://push.example/send/1",
  p256dh: "p256dh",
  auth: "auth",
  filters: { news: true, alerts: true },
  failure_count: 0,
};
const EVENT: NewsEventRow = { id: "ev-1", title: "美联储维持利率不变", first_published_at: "2026-10-16T11:59:00.000Z" };
const CRITICAL: AlertRow = {
  id: "al-1",
  kind: "pct_move",
  symbol: "MU",
  severity: "critical",
  payload: { message: "MU 5 分钟涨幅 4.2%" },
  triggered_at: "2026-10-16T11:59:30.000Z",
};
const WARNING: AlertRow = { ...CRITICAL, id: "al-2", severity: "warning" };

interface SentCall {
  target: PushSubscriptionKeys;
  payload: string;
  urgency?: string;
}

function fakeStore(overrides: Partial<PushStore> = {}) {
  const calls = {
    claims: [] as string[],
    released: [] as string[],
    deleted: [] as string[],
    succeeded: [] as string[],
    failedMarks: [] as string[],
  };
  const store: PushStore = {
    listSubscriptions: () => Promise.resolve([SUB]),
    recentNewsEvents: () => Promise.resolve([EVENT]),
    recentAlerts: () => Promise.resolve([CRITICAL, WARNING]),
    claimDelivery: (_id, key) => {
      calls.claims.push(key);
      return Promise.resolve(true);
    },
    releaseDelivery: (_id, key) => {
      calls.released.push(key);
      return Promise.resolve();
    },
    deleteSubscription: (id) => {
      calls.deleted.push(id);
      return Promise.resolve();
    },
    markSuccess: (id) => {
      calls.succeeded.push(id);
      return Promise.resolve();
    },
    markFailure: (sub) => {
      calls.failedMarks.push(sub.id);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { store, calls };
}

function makeHandler(store: PushStore, sendPush: SendPushFunction, extra: Record<string, unknown> = {}) {
  return createPushNotifyHandler({
    cronSecret: SECRET,
    vapid: VAPID,
    store,
    now: () => NOW,
    sendPush,
    ...extra,
  });
}

function authedRequest(method = "POST"): Request {
  return new Request("http://localhost/push-notify", { method, headers: { authorization: `Bearer ${SECRET}` } });
}

Deno.test("rejects bad methods, missing secret config, and wrong secrets", async () => {
  const { store } = fakeStore();
  const send = () => Promise.resolve({ status: 201, gone: false });
  const handler = makeHandler(store, send);
  strictEqual((await handler(new Request("http://localhost", { method: "DELETE" }))).status, 405);
  strictEqual((await handler(new Request("http://localhost", { method: "POST" }))).status, 401);

  const unconfigured = createPushNotifyHandler({ cronSecret: undefined, vapid: VAPID, store });
  strictEqual((await unconfigured(authedRequest())).status, 500);

  const noVapid = createPushNotifyHandler({ cronSecret: SECRET, vapid: undefined, store });
  strictEqual((await noVapid(authedRequest())).status, 500);
});

Deno.test("sends news and critical alerts, skipping warning alerts", async () => {
  const { store, calls } = fakeStore();
  const sent: SentCall[] = [];
  const handler = makeHandler(store, (target, payload, _vapid, opts) => {
    sent.push({ target, payload, urgency: opts?.urgency });
    return Promise.resolve({ status: 201, gone: false });
  });
  const response = await handler(authedRequest());
  strictEqual(response.status, 200);
  const summary = (await response.json()) as Record<string, unknown>;
  strictEqual(summary.ok, true);
  strictEqual(summary.subscriptions, 1);
  strictEqual(summary.candidates, 2);
  strictEqual(summary.sent, 2);
  strictEqual(summary.skipped, 0);
  strictEqual(summary.gone, 0);
  strictEqual(summary.failed, 0);
  strictEqual(sent.length, 2);
  const newsPayload = JSON.parse(sent[0]!.payload) as Record<string, string>;
  strictEqual(newsPayload.title, "Hive 新闻");
  strictEqual(newsPayload.body, EVENT.title);
  strictEqual(newsPayload.url, "/news");
  const alertPayload = JSON.parse(sent[1]!.payload) as Record<string, string>;
  strictEqual(alertPayload.body, "MU 5 分钟涨幅 4.2%");
  strictEqual(sent[1]!.urgency, "high");
  strictEqual(calls.succeeded.length, 2);
});

Deno.test("honours subscription filters", async () => {
  const { store } = fakeStore({
    listSubscriptions: () => Promise.resolve([{ ...SUB, filters: { news: false, alerts: true } }]),
  });
  const sent: string[] = [];
  const handler = makeHandler(store, (_t, payload) => {
    sent.push(payload);
    return Promise.resolve({ status: 201, gone: false });
  });
  await handler(authedRequest());
  strictEqual(sent.length, 1);
  ok(sent[0]!.includes("Hive 告警"));
});

Deno.test("skips already-claimed deliveries", async () => {
  const { store } = fakeStore({ claimDelivery: () => Promise.resolve(false) });
  let sends = 0;
  const handler = makeHandler(store, () => {
    sends++;
    return Promise.resolve({ status: 201, gone: false });
  });
  const summary = (await (await handler(authedRequest())).json()) as Record<string, number>;
  strictEqual(sends, 0);
  strictEqual(summary.skipped, 2);
});

Deno.test("deletes gone subscriptions and stops sending to them", async () => {
  const { store, calls } = fakeStore();
  const handler = makeHandler(store, () => Promise.resolve({ status: 410, gone: true }));
  const summary = (await (await handler(authedRequest())).json()) as Record<string, number>;
  strictEqual(summary.gone, 1);
  deepStrictEqual(calls.deleted, ["sub-1"]);
});

Deno.test("releases the claim and records the failure when sending throws", async () => {
  const { store, calls } = fakeStore();
  const handler = makeHandler(store, () => Promise.reject(new Error("network down")));
  const summary = (await (await handler(authedRequest())).json()) as Record<string, number>;
  strictEqual(summary.failed, 2);
  deepStrictEqual(calls.released.sort(), ["alert:al-1", "news:ev-1"]);
  strictEqual(calls.failedMarks.length, 2);
});

Deno.test("parsePushFilters and buildCandidates units", () => {
  deepStrictEqual(parsePushFilters(null), { news: true, alerts: true });
  deepStrictEqual(parsePushFilters({ news: false }), { news: false, alerts: true });
  deepStrictEqual(parsePushFilters("junk"), { news: true, alerts: true });
  const candidates = buildCandidates([EVENT], [CRITICAL, WARNING, { ...CRITICAL, id: "al-3", kind: "source_stale", severity: "warning" }]);
  strictEqual(candidates.length, 3);
  strictEqual(candidates[2]!.eventKey, "alert:al-3");
});
