import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  createTelegramDispatcher,
  type TelegramCandle,
  type TelegramCandleQuery,
  type TelegramDeliveryOutcome,
  type TelegramDispatchStore,
  type TelegramDueDelivery,
} from "./handler.ts";

const CRON_SECRET = "test-cron-secret";
const BOT_TOKEN = "FAKE_BOT_TOKEN";
const NOW_MS = Date.parse("2026-11-02T05:36:00.000Z");

function due(overrides: Partial<TelegramDueDelivery> = {}): TelegramDueDelivery {
  return {
    deliveryId: 7,
    chatId: "987654321",
    botToken: BOT_TOKEN,
    eventType: "alert",
    payload: {
      type: "alert",
      kind: "volume_spike",
      symbol: "SH513310",
      source: "sina",
      severity: "warning",
      triggered_at: "2026-11-02T05:36:10.244421+00:00",
      payload: {
        // Shape written by alert-evaluator buildAlert: bar_ts is the ISO open time of the triggering bar.
        bar_ts: new Date(Date.UTC(2026, 10, 2, 5, 30, 0)).toISOString(),
        interval: "15m",
        details: { last_price: 3.883, last_volume: 208_300_000, observed_multiple: 2.35, multiple: 2, lookback: 6 },
      },
    },
    attempts: 1,
    maxAttempts: 6,
    ...overrides,
  };
}

function retracementDue(): TelegramDueDelivery {
  return due({
    deliveryId: 8,
    payload: {
      type: "alert",
      kind: "retracement",
      symbol: "XAU",
      source: "yahoo",
      triggered_at: "2026-11-03T13:45:00.000Z",
      payload: {
        bar_ts: "2026-11-03T13:30:00.000Z",
        interval: "15m",
        details: { is_top: 1, last_price: 4012.5, anchor_price: 4040, retrace_pct: 0.6807, lookback: 20 },
      },
    },
  });
}

const BAR_MS = Date.parse("2026-11-02T05:30:00.000Z");

function candles(limit: number): TelegramCandle[] {
  const start = BAR_MS - (limit - 1) * 900_000;
  return Array.from({ length: limit }, (_, i) => ({
    ts: start + i * 900_000,
    open: 3.8 + i * 0.002,
    high: 3.85 + i * 0.002,
    low: 3.78 + i * 0.002,
    close: 3.883,
  }));
}

function fakeStore(items: TelegramDueDelivery[] = [due()], options: { withCandles?: boolean; candlesFail?: boolean } = {}) {
  const marks: { id: number; outcome: TelegramDeliveryOutcome }[] = [];
  const released: number[][] = [];
  const candleQueries: TelegramCandleQuery[] = [];
  let calls = 0;
  const store: TelegramDispatchStore = {
    async claim() {
      calls += 1;
      // First call returns the batch, later calls return empty so the loop ends.
      return calls === 1 ? items : [];
    },
    async release(ids) {
      released.push(ids);
    },
    async mark(id, outcome) {
      marks.push({ id, outcome });
      if (outcome.ok) return "delivered";
      const item = items.find((candidate) => candidate.deliveryId === id);
      return item && item.attempts >= item.maxAttempts ? "dead" : "pending";
    },
  };
  if (options.withCandles) {
    store.candles = async (query) => {
      candleQueries.push(query);
      if (options.candlesFail) throw new Error("candles read failed");
      return candles(query.limit);
    };
  }
  return { store, marks, released, candleQueries };
}

interface Sent {
  url: string;
  body: string;
}

function fakeFetch(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: Sent = { url: String(input), body: String(init?.body ?? "") };
    sent.push(record);
    return respond(record);
  }) as typeof fetch;
  return { impl, sent };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function dispatcher(store: TelegramDispatchStore, fetchImpl: typeof fetch) {
  return createTelegramDispatcher({ cronSecret: CRON_SECRET, store, fetchImpl, now: () => NOW_MS, log: () => undefined });
}

async function post(handler: (request: Request) => Promise<Response>, auth = `Bearer ${CRON_SECRET}`) {
  return handler(new Request("https://example.com/", { method: "POST", headers: { authorization: auth } }));
}

function methodOf(sent: Sent): string {
  return sent.url.split("/").pop() ?? "";
}

Deno.test("rejects wrong method, missing secret config and bad auth", async () => {
  const { store } = fakeStore([]);
  const { impl } = fakeFetch(() => jsonResponse(200, { ok: true }));
  const handler = dispatcher(store, impl);
  strictEqual((await handler(new Request("https://example.com/", { method: "GET" }))).status, 405);
  strictEqual((await post(handler, "Bearer wrong")).status, 401);
  const noSecret = createTelegramDispatcher({ cronSecret: undefined, store, fetchImpl: impl, now: () => NOW_MS, log: () => undefined });
  strictEqual((await post(noSecret)).status, 500);
});

Deno.test("sends a text message with measured and threshold multiples when no candles are available", async () => {
  const { store, marks } = fakeStore();
  const { impl, sent } = fakeFetch(() => jsonResponse(200, { ok: true, result: { message_id: 1 } }));
  const response = await post(dispatcher(store, impl));
  strictEqual(response.status, 200);
  const summary = await response.json() as { delivered: number; claimed: number };
  strictEqual(summary.delivered, 1);
  strictEqual(summary.claimed, 1);
  strictEqual(sent.length, 1);
  strictEqual(methodOf(sent[0]), "sendMessage");
  const body = JSON.parse(sent[0].body) as { chat_id: string; text: string };
  strictEqual(body.chat_id, "987654321");
  ok(body.text.includes("放量 · SH513310"));
  ok(body.text.includes("实测 2.35 倍"));
  ok(body.text.includes("阈值 2 倍"));
  deepStrictEqual(marks.map((m) => m.outcome.ok), [true]);
  strictEqual(marks[0].outcome.withPhoto, false);
});

Deno.test("delivers a retracement as one photo message with the text as caption", async () => {
  const { store, marks, candleQueries } = fakeStore([retracementDue()], { withCandles: true });
  const { impl, sent } = fakeFetch(() => jsonResponse(200, { ok: true, result: { message_id: 2 } }));
  const response = await post(dispatcher(store, impl));
  strictEqual(response.status, 200);
  strictEqual(sent.length, 1);
  strictEqual(methodOf(sent[0]), "sendPhoto");
  const body = JSON.parse(sent[0].body) as { chat_id: string; photo: string; caption: string };
  strictEqual(body.chat_id, "987654321");
  ok(body.photo.startsWith("https://quickchart.io/chart?"));
  ok(body.photo.length <= 4000);
  ok(body.caption.startsWith("疑似顶部 · XAU"));
  ok(body.caption.includes("高点锚 4040"));
  ok(body.caption.includes("偏离 -0.6807%"));
  ok(!/买入|卖出|做多|做空/.test(body.caption));
  deepStrictEqual(candleQueries, [{ symbol: "XAU", source: "yahoo", interval: "15m", limit: 30 }]);
  strictEqual(marks[0].outcome.ok, true);
  strictEqual(marks[0].outcome.withPhoto, true);
  strictEqual(marks[0].outcome.responseStatus, 200);
});

Deno.test("a failing photo degrades to text and still marks the delivery delivered", async () => {
  const { store, marks } = fakeStore([retracementDue()], { withCandles: true });
  const { impl, sent } = fakeFetch((request) =>
    methodOf(request) === "sendPhoto"
      ? jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: failed to get HTTP URL content" })
      : jsonResponse(200, { ok: true })
  );
  await post(dispatcher(store, impl));
  deepStrictEqual(sent.map(methodOf), ["sendPhoto", "sendMessage"]);
  const fallback = JSON.parse(sent[1].body) as { text: string };
  ok(fallback.text.includes("疑似顶部 · XAU"));
  strictEqual(marks.length, 1);
  strictEqual(marks[0].outcome.ok, true);
  strictEqual(marks[0].outcome.withPhoto, false);
});

Deno.test("a candle read failure degrades to text without losing the alert", async () => {
  const { store, marks } = fakeStore([retracementDue()], { withCandles: true, candlesFail: true });
  const { impl, sent } = fakeFetch(() => jsonResponse(200, { ok: true }));
  await post(dispatcher(store, impl));
  deepStrictEqual(sent.map(methodOf), ["sendMessage"]);
  strictEqual(marks[0].outcome.ok, true);
  strictEqual(marks[0].outcome.withPhoto, false);
});

Deno.test("the chart covers only bars up to the triggering one", async () => {
  const { store } = fakeStore([retracementDue()], { withCandles: true });
  const { impl, sent } = fakeFetch(() => jsonResponse(200, { ok: true }));
  await post(dispatcher(store, impl));
  const body = JSON.parse(sent[0].body) as { photo: string };
  const c = new URL(body.photo).searchParams.get("c")!;
  // 30 candles plus the anchor line and the trigger marker on the last slot (index 29).
  strictEqual(c.match(/\{x:\d+,o:/g)?.length, 30);
  ok(c.includes("{type:'line',label:'高点锚 4040'"));
  ok(c.includes("{type:'scatter',label:'触发 4012.5',data:[{x:29,y:4012.5}]"));
});

Deno.test("a late delivery never draws bars after the alert's bar", async () => {
  // The alert fired on the 05:30Z bar; by delivery time the series has run 10 bars further. Those must not
  // appear: the chart has to look the way the alert describes it.
  const late = retracementDue();
  const barTsMs = Date.parse("2026-11-03T13:30:00.000Z");
  const store = fakeStore([{ ...late, deliveryId: 9 }]).store;
  store.candles = async (query) =>
    Array.from({ length: query.limit }, (_, i) => ({
      ts: barTsMs - (query.limit - 11) * 900_000 + i * 900_000,
      open: 4000,
      high: 4010,
      low: 3990,
      close: 4000,
    }));
  const { impl, sent } = fakeFetch(() => jsonResponse(200, { ok: true }));
  await post(dispatcher(store, impl));
  const body = JSON.parse(sent[0].body) as { photo: string };
  const c = new URL(body.photo).searchParams.get("c")!;
  // 20 bars at or before the trigger; the 10 later bars are dropped.
  strictEqual(c.match(/\{x:\d+,o:/g)?.length, 20);
});

Deno.test("missing bot token never sends and backs off to the cap", async () => {
  const { store, marks } = fakeStore([due({ botToken: null })]);
  const { impl, sent } = fakeFetch(() => jsonResponse(200, { ok: true }));
  const response = await post(dispatcher(store, impl));
  strictEqual(response.status, 200);
  strictEqual(sent.length, 0);
  strictEqual(marks.length, 1);
  strictEqual(marks[0].outcome.ok, false);
  strictEqual(marks[0].outcome.backoffSeconds, 3600);
});

Deno.test("Telegram 429 honors retry_after", async () => {
  const { store, marks } = fakeStore();
  const { impl } = fakeFetch(() =>
    jsonResponse(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 120 } })
  );
  await post(dispatcher(store, impl));
  strictEqual(marks.length, 1);
  strictEqual(marks[0].outcome.ok, false);
  strictEqual(marks[0].outcome.backoffSeconds, 120);
  strictEqual(marks[0].outcome.responseStatus, 429);
});

Deno.test("one failure does not block the rest of the batch", async () => {
  const items = [due({ deliveryId: 1 }), due({ deliveryId: 2 })];
  const { store: store2, marks: marks2 } = fakeStore(items);
  let calls = 0;
  const { impl: impl2 } = fakeFetch(() => {
    calls += 1;
    return calls === 1
      ? jsonResponse(500, { ok: false, description: "Server error" })
      : jsonResponse(200, { ok: true });
  });
  const response = await post(dispatcher(store2, impl2));
  const summary = await response.json() as { delivered: number; failed: number };
  strictEqual(summary.delivered, 1);
  strictEqual(summary.failed, 1);
  strictEqual(marks2.length, 2);
});
