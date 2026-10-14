import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { computeBackoffSeconds, MAX_BACKOFF_SECONDS, verifyWebhookSignature } from "./core/webhook.ts";
import { createWebhookDispatcher, type DeliveryOutcome, type DispatchStore, type DueDelivery } from "./handler.ts";

const CRON_SECRET = "test-cron-secret";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-10-13T12:00:00.000Z");

function due(overrides: Partial<DueDelivery> = {}): DueDelivery {
  return {
    deliveryId: 7,
    agentName: "trader-bot",
    url: "https://agent.example.com/hook",
    secret: SIGNING_SECRET,
    authToken: null,
    eventType: "news",
    payload: { type: "news", id: 1, title: "美联储" },
    attempts: 1,
    maxAttempts: 6,
    ...overrides,
  };
}

function fakeStore(items: DueDelivery[] = [due()], options: { markError?: Error; claimError?: Error } = {}) {
  const marks: { id: number; outcome: DeliveryOutcome }[] = [];
  const store: DispatchStore = {
    async claim() {
      if (options.claimError) throw options.claimError;
      return items;
    },
    async mark(id, outcome) {
      if (options.markError) throw options.markError;
      marks.push({ id, outcome });
      const item = items.find((candidate) => candidate.deliveryId === id);
      if (outcome.ok) return "delivered";
      return item && item.attempts >= item.maxAttempts ? "dead" : "pending";
    },
  };
  return { store, marks };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}

function fakeFetch(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: Sent = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ""),
      redirect: init?.redirect,
    };
    sent.push(record);
    return respond(record);
  }) as typeof fetch;
  return { impl, sent };
}

function dispatcher(store: DispatchStore, fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createWebhookDispatcher>[0]> = {}) {
  return createWebhookDispatcher({
    cronSecret: CRON_SECRET,
    store,
    fetchImpl,
    now: () => NOW_MS,
    log: () => undefined,
    ...extra,
  });
}

function trigger(authorization: string | null = `Bearer ${CRON_SECRET}`, method = "POST"): Request {
  return new Request("https://functions.test/webhook-dispatcher", {
    method,
    headers: authorization ? { authorization } : {},
  });
}

Deno.test("rejects non-POST, missing or wrong tokens, and fails closed without a cron secret", async () => {
  const { store } = fakeStore();
  const { impl, sent } = fakeFetch(() => new Response("ok"));
  strictEqual((await dispatcher(store, impl)(trigger(`Bearer ${CRON_SECRET}`, "GET"))).status, 405);
  strictEqual((await dispatcher(store, impl)(trigger(null))).status, 401);
  strictEqual((await dispatcher(store, impl)(trigger("Bearer nope"))).status, 401);
  strictEqual((await createWebhookDispatcher({ cronSecret: undefined, store })(trigger())).status, 500);
  strictEqual(sent.length, 0);
});

Deno.test("reports idle when nothing is due", async () => {
  const { store } = fakeStore([]);
  const { impl, sent } = fakeFetch(() => new Response("ok"));
  const body = await (await dispatcher(store, impl)(trigger())).json();
  strictEqual(body.status, "idle");
  strictEqual(body.claimed, 0);
  strictEqual(sent.length, 0);
});

Deno.test("signs the exact body that is sent, with headers a receiver can verify", async () => {
  const { store, marks } = fakeStore();
  const { impl, sent } = fakeFetch(() => new Response(null, { status: 204 }));
  const body = await (await dispatcher(store, impl)(trigger())).json();

  strictEqual(body.status, "ok");
  strictEqual(body.delivered, 1);
  strictEqual(sent.length, 1);
  const request = sent[0]!;
  strictEqual(request.url, "https://agent.example.com/hook");
  strictEqual(request.redirect, "manual");
  strictEqual(request.headers["x-hive-event"], "news");
  strictEqual(request.headers["x-hive-delivery-id"], "7");
  const timestamp = Number(request.headers["x-hive-timestamp"]);
  strictEqual(timestamp, NOW_MS / 1000);
  ok(verifyWebhookSignature(SIGNING_SECRET, timestamp, request.body, request.headers["x-hive-signature"]!, timestamp));
  ok(!verifyWebhookSignature("another-secret-value-0123456789ab", timestamp, request.body, request.headers["x-hive-signature"]!, timestamp));

  const envelope = JSON.parse(request.body);
  deepStrictEqual(Object.keys(envelope).sort(), ["created_at", "data", "delivery_id", "event"]);
  strictEqual(envelope.delivery_id, 7);
  strictEqual(envelope.data.title, "美联储");
  deepStrictEqual(marks, [{ id: 7, outcome: { ok: true, responseStatus: 204, error: null, backoffSeconds: 0 } }]);
});

Deno.test("records a non-2xx response with the capped backoff for its attempt number", async () => {
  const { store, marks } = fakeStore([due({ attempts: 3 })]);
  const { impl } = fakeFetch(() => new Response("nope", { status: 500 }));
  const body = await (await dispatcher(store, impl)(trigger())).json();
  strictEqual(body.status, "partial");
  strictEqual(body.failed, 1);
  deepStrictEqual(marks[0]!.outcome, { ok: false, responseStatus: 500, error: "HTTP 500", backoffSeconds: computeBackoffSeconds(3) });
});

Deno.test("does not follow redirects, so a signed body is never sent to a second host", async () => {
  const { store, marks } = fakeStore();
  const { impl } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }));
  await dispatcher(store, impl)(trigger());
  strictEqual(marks[0]!.outcome.ok, false);
  ok(marks[0]!.outcome.error!.includes("redirects are not followed"));
});

Deno.test("records a network failure without leaking the signing secret", async () => {
  const { store, marks } = fakeStore();
  const { impl } = fakeFetch(() => {
    throw new TypeError("connection reset");
  });
  await dispatcher(store, impl)(trigger());
  strictEqual(marks[0]!.outcome.ok, false);
  strictEqual(marks[0]!.outcome.responseStatus, null);
  ok(marks[0]!.outcome.error!.startsWith("request failed"));
  ok(!JSON.stringify(marks).includes(SIGNING_SECRET));
});

Deno.test("times out a slow receiver and records it as a failed attempt", async () => {
  const { store, marks } = fakeStore();
  const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
    })) as typeof fetch;
  await dispatcher(store, hangingFetch, { requestTimeoutMs: 20 })(trigger());
  strictEqual(marks[0]!.outcome.ok, false);
  ok(marks[0]!.outcome.error!.includes("request failed"));
});

Deno.test("sends the bearer token alongside the HMAC headers when the subscription has one", async () => {
  const token = "grok-routine-key-0123456789ab";
  const { store, marks } = fakeStore([due({ authToken: token })]);
  const { impl, sent } = fakeFetch(() => new Response(null, { status: 200 }));
  await dispatcher(store, impl)(trigger());
  strictEqual(sent[0]!.headers["authorization"], `Bearer ${token}`);
  const timestamp = Number(sent[0]!.headers["x-hive-timestamp"]);
  ok(verifyWebhookSignature(SIGNING_SECRET, timestamp, sent[0]!.body, sent[0]!.headers["x-hive-signature"]!, timestamp));
  strictEqual(marks[0]!.outcome.ok, true);
});

Deno.test("sends no Authorization header when the subscription has no bearer token", async () => {
  const { store } = fakeStore([due({ authToken: null })]);
  const { impl, sent } = fakeFetch(() => new Response(null, { status: 200 }));
  await dispatcher(store, impl)(trigger());
  strictEqual(sent[0]!.headers["authorization"], undefined);
  ok(sent[0]!.headers["x-hive-signature"]!.startsWith("sha256="));
});

Deno.test("never records the bearer token in outcomes, even when the receiver echoes it", async () => {
  const token = "grok-routine-key-0123456789ab";
  const { store, marks } = fakeStore([due({ authToken: token })]);
  const { impl } = fakeFetch(() => new Response(`rejected ${token}`, { status: 401 }));
  await dispatcher(store, impl)(trigger());
  strictEqual(marks[0]!.outcome.ok, false);
  ok(!JSON.stringify(marks).includes(token));
});

Deno.test("refuses to send unsigned: a missing signing secret is recorded as a failure with a long backoff", async () => {
  const { store, marks } = fakeStore([due({ secret: null })]);
  const { impl, sent } = fakeFetch(() => new Response("ok"));
  await dispatcher(store, impl)(trigger());
  strictEqual(sent.length, 0);
  strictEqual(marks[0]!.outcome.error, "subscription has no signing secret; not sent");
  strictEqual(marks[0]!.outcome.backoffSeconds, MAX_BACKOFF_SECONDS);
});

Deno.test("marks a delivery dead once it has used its last attempt", async () => {
  const { store, marks } = fakeStore([due({ attempts: 6, maxAttempts: 6 })]);
  const { impl } = fakeFetch(() => new Response("down", { status: 503 }));
  const body = await (await dispatcher(store, impl)(trigger())).json();
  strictEqual(body.dead, 1);
  strictEqual(body.status, "partial");
  strictEqual(marks.length, 1);
});

Deno.test("keeps going when recording one outcome fails, and reports mark_failed", async () => {
  const { store } = fakeStore([due(), due({ deliveryId: 8 })], { markError: new Error("db down") });
  const { impl, sent } = fakeFetch(() => new Response(null, { status: 200 }));
  const response = await dispatcher(store, impl)(trigger());
  strictEqual(response.status, 200);
  strictEqual(sent.length, 2);
  strictEqual((await response.json()).failed, 2);
});

Deno.test("returns 500 without sending anything when claiming fails", async () => {
  const { store } = fakeStore([], { claimError: new Error("PostgREST rpc returned HTTP 500") });
  const { impl, sent } = fakeFetch(() => new Response("ok"));
  const response = await dispatcher(store, impl)(trigger());
  strictEqual(response.status, 500);
  strictEqual(sent.length, 0);
});

Deno.test("delivers in parallel chunks and reports each outcome", async () => {
  const items = Array.from({ length: 5 }, (_, i) => due({ deliveryId: 100 + i }));
  const { store, marks } = fakeStore(items);
  const { impl } = fakeFetch(({ url }) => new Response(null, { status: url.includes("bad") ? 500 : 200 }));
  const body = await (await dispatcher(store, impl, { concurrency: 2 })(trigger())).json();
  strictEqual(body.claimed, 5);
  strictEqual(body.delivered, 5);
  deepStrictEqual(marks.map((m) => m.id).sort((a, b) => a - b), [100, 101, 102, 103, 104]);
});

function pagedStore(pages: DueDelivery[][]) {
  const marks: { id: number; outcome: DeliveryOutcome }[] = [];
  let claims = 0;
  const store: DispatchStore = {
    async claim() {
      claims += 1;
      return pages[claims - 1] ?? [];
    },
    async mark(id, outcome) {
      marks.push({ id, outcome });
      return outcome.ok ? "delivered" : "pending";
    },
  };
  return { store, marks, claims: () => claims };
}

Deno.test("drains a backlog larger than one batch within a single run", async () => {
  const pages = [
    [due({ deliveryId: 1 }), due({ deliveryId: 2 })],
    [due({ deliveryId: 3 }), due({ deliveryId: 4 })],
    [due({ deliveryId: 5 })],
  ];
  const { store, marks, claims } = pagedStore(pages);
  const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
  const body = await (await dispatcher(store, impl, { batchSize: 2, concurrency: 2 })(trigger())).json();
  strictEqual(claims(), 3);
  strictEqual(body.claimed, 5);
  strictEqual(body.delivered, 5);
  strictEqual(body.status, "ok");
  deepStrictEqual(marks.map((m) => m.id).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

Deno.test("does not claim a batch it cannot finish inside the budget, so nothing is left leased", async () => {
  const pages = [[due({ deliveryId: 1 })], [due({ deliveryId: 2 })]];
  const { store, marks, claims } = pagedStore(pages);
  const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
  const body = await (await dispatcher(store, impl, { batchSize: 1, concurrency: 1, budgetMs: 100, requestTimeoutMs: 1000 })(trigger())).json();
  strictEqual(claims(), 1);
  strictEqual(body.claimed, 1);
  deepStrictEqual(marks.map((m) => m.id), [1]);
});

Deno.test("keeps the delivered rows when a later claim in the same run fails", async () => {
  let claims = 0;
  const store: DispatchStore = {
    async claim() {
      claims += 1;
      if (claims === 1) return [due({ deliveryId: 1 }), due({ deliveryId: 2 })];
      throw new Error("PostgREST rpc returned HTTP 500");
    },
    async mark() {
      return "delivered";
    },
  };
  const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
  const response = await dispatcher(store, impl, { batchSize: 2, concurrency: 2 })(trigger());
  strictEqual(response.status, 200);
  strictEqual((await response.json()).delivered, 2);
});
