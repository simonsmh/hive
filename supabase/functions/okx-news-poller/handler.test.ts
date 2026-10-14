import { createHmac } from "node:crypto";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { NewsIngestRow } from "./core/news.ts";
import {
  createOkxNewsHandler,
  DEFAULT_OKX_NEWS_CONFIG,
  LOOKBACK_MS,
  type IngestResult,
  type OkxNewsConfig,
  type OkxNewsStore,
  OVERLAP_MS,
  windowStart,
} from "./handler.ts";

const SECRET = "test-cron-secret";
const CONFIG: OkxNewsConfig = { baseUrl: "https://okx.test" };
const NOW = Date.parse("2026-10-13T12:00:00.000Z");

function request(authorization: string | null = `Bearer ${SECRET}`, method = "POST"): Request {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return new Request("https://functions.test/okx-news-poller", { method, headers });
}

function newsItem(id: number, cTimeMs: number) {
  return {
    id: String(id),
    cTime: String(cTimeMs),
    title: `标题 ${id}`,
    summary: "摘要",
    content: `<b>内容 ${id}</b>`,
    importance: "high",
    sourceUrl: `https://www.okx.com/zh-hans/feed/post/${id}`,
    platformList: [],
    ccyList: ["BTC"],
    ccySentiments: [],
  };
}

function fakeStore(options: {
  latest?: string | null;
  latestError?: Error;
  ingest?: IngestResult;
  ingestError?: Error;
  recordError?: Error;
} = {}) {
  const ingested: NewsIngestRow[][] = [];
  const failures: string[] = [];
  const store: OkxNewsStore = {
    async latestPublishedAt() {
      if (options.latestError) throw options.latestError;
      return options.latest ?? null;
    },
    async ingest(rows) {
      if (options.ingestError) throw options.ingestError;
      ingested.push(rows);
      return options.ingest ?? { inserted: rows.length, duplicates: 0 };
    },
    async recordFailure(error) {
      if (options.recordError) throw options.recordError;
      failures.push(error);
    },
  };
  return { store, ingested, failures };
}

type Reply = { status?: number; body: string };

function fakeFetch(reply: (url: URL, call: number) => Reply) {
  const calls: URL[] = [];
  const headers: Record<string, string>[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const { status = 200, body } = reply(url, calls.length);
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, calls, headers };
}

function okBody(details: unknown[]): string {
  return JSON.stringify({ details, nextCursor: "" });
}

function handlerWith(store: OkxNewsStore, fetchImpl: typeof fetch) {
  return createOkxNewsHandler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl,
    now: () => NOW,
    log: () => undefined,
  });
}

Deno.test("rejects non-POST requests before any upstream call", async () => {
  const fetched = fakeFetch(() => ({ body: okBody([]) }));
  const { store } = fakeStore();
  strictEqual((await handlerWith(store, fetched.impl)(request(`Bearer ${SECRET}`, "GET"))).status, 405);
  strictEqual(fetched.calls.length, 0);
});

Deno.test("fails closed when EDGE_CRON_SECRET is not configured", async () => {
  const { store } = fakeStore();
  const response = await createOkxNewsHandler({
    cronSecret: undefined,
    store,
    config: CONFIG,
    fetchImpl: fakeFetch(() => ({ body: okBody([]) })).impl,
    now: () => NOW,
    log: () => undefined,
  })(request());
  strictEqual(response.status, 500);
});

Deno.test("rejects a missing or wrong bearer token before any upstream call", async () => {
  const fetched = fakeFetch(() => ({ body: okBody([newsItem(1, NOW - 1000)]) }));
  const { store } = fakeStore();
  const handle = handlerWith(store, fetched.impl);
  strictEqual((await handle(request(null))).status, 401);
  strictEqual((await handle(request("Bearer wrong"))).status, 401);
  strictEqual(fetched.calls.length, 0);
});

Deno.test("requests high-importance news in a window anchored on the newest stored item", async () => {
  const latest = "2026-10-13T11:50:00.000Z";
  const fetched = fakeFetch(() => ({ body: okBody([newsItem(1, NOW - 60_000)]) }));
  const { store, ingested } = fakeStore({ latest });
  const response = await handlerWith(store, fetched.impl)(request());

  strictEqual(response.status, 200);
  deepStrictEqual(await response.json(), {
    status: "ok",
    pages: 1,
    fetched: 1,
    inserted: 1,
    duplicates: 0,
    truncated: false,
    durationMs: 0,
  });

  strictEqual(fetched.calls.length, 1);
  const call = fetched.calls[0]!;
  strictEqual(call.origin + call.pathname, "https://okx.test/api/v5/orbit/news-search");
  strictEqual(call.searchParams.get("sortBy"), "latest");
  strictEqual(call.searchParams.get("importance"), "high");
  strictEqual(call.searchParams.get("limit"), "50");
  strictEqual(call.searchParams.get("acceptLanguage"), "en_US");
  strictEqual(call.searchParams.get("end"), String(NOW));
  strictEqual(call.searchParams.get("begin"), String(Date.parse(latest) - OVERLAP_MS));

  const [row] = ingested[0]!;
  strictEqual(row!.external_id, "1");
  strictEqual(row!.score, 1);
  strictEqual(row!.body, "内容 1");
  strictEqual(row!.url, "https://www.okx.com/zh-hans/feed/post/1");
  strictEqual(row!.published_at, new Date(NOW - 60_000).toISOString());
});

Deno.test("windowStart clamps the anchor to the lookback and to the present", () => {
  strictEqual(windowStart(null, NOW), NOW - LOOKBACK_MS - OVERLAP_MS);
  strictEqual(windowStart("not a time", NOW), NOW - LOOKBACK_MS - OVERLAP_MS);
  strictEqual(windowStart("2020-01-01T00:00:00.000Z", NOW), NOW - LOOKBACK_MS - OVERLAP_MS);
  strictEqual(windowStart(new Date(NOW + 3_600_000).toISOString(), NOW), NOW - OVERLAP_MS);
  strictEqual(windowStart(new Date(NOW - 300_000).toISOString(), NOW), NOW - 300_000 - OVERLAP_MS);
});

Deno.test("pages backwards with end = oldest cTime - 1 while pages are full", async () => {
  const pageOne = Array.from({ length: 50 }, (_, i) => newsItem(i + 1, NOW - (i + 1) * 1000));
  const oldest = NOW - 50 * 1000;
  const pageTwo = Array.from({ length: 3 }, (_, i) => newsItem(51 + i, oldest - (i + 1) * 1000));
  const fetched = fakeFetch((_url, call) => ({ body: okBody(call === 1 ? pageOne : pageTwo) }));
  const { store, ingested } = fakeStore();
  const response = await handlerWith(store, fetched.impl)(request());

  const body = await response.json();
  strictEqual(body.status, "ok");
  strictEqual(body.pages, 2);
  strictEqual(body.fetched, 53);
  strictEqual(body.truncated, false);
  strictEqual(fetched.calls[1]!.searchParams.get("end"), String(oldest - 1));
  strictEqual(ingested[0]!.length, 53);
});

Deno.test("stops at the page cap, reports truncation, and still ingests what it fetched", async () => {
  const fetched = fakeFetch((_url, call) => ({
    body: okBody(Array.from({ length: 50 }, (_, i) => newsItem(call * 100 + i, NOW - (call * 50 + i) * 1000))),
  }));
  const { store, ingested } = fakeStore();
  const body = await (await handlerWith(store, fetched.impl)(request())).json();

  strictEqual(fetched.calls.length, 10);
  strictEqual(body.status, "ok");
  strictEqual(body.truncated, true);
  strictEqual(body.fetched, 500);
  strictEqual(ingested[0]!.length, 500);
});

Deno.test("writes nothing and records the failure when a later page fails", async () => {
  const fetched = fakeFetch((_url, call) =>
    call === 1
      ? { body: okBody(Array.from({ length: 50 }, (_, i) => newsItem(i + 1, NOW - (i + 1) * 1000))) }
      : { status: 502, body: "bad gateway" },
  );
  const { store, ingested, failures } = fakeStore();
  const response = await handlerWith(store, fetched.impl)(request());

  strictEqual(response.status, 200);
  deepStrictEqual(await response.json(), { status: "degraded", error: "okx-news HTTP 502" });
  strictEqual(ingested.length, 0);
  deepStrictEqual(failures, ["okx-news HTTP 502"]);
});

Deno.test("reports a degraded source on an upstream HTTP error", async () => {
  const { store, failures, ingested } = fakeStore();
  const response = await handlerWith(store, fakeFetch(() => ({ status: 403, body: "forbidden" })).impl)(request());
  deepStrictEqual(await response.json(), { status: "degraded", error: "okx-news HTTP 403" });
  deepStrictEqual(failures, ["okx-news HTTP 403"]);
  strictEqual(ingested.length, 0);
});

Deno.test("treats an HTML block page as a format change rather than an empty feed", async () => {
  const { store, failures } = fakeStore();
  const body = await (await handlerWith(store, fakeFetch(() => ({ body: "<html>Access denied</html>" })).impl)(request())).json();
  strictEqual(body.status, "degraded");
  ok(String(body.error).includes("not JSON"));
  strictEqual(failures.length, 1);
});

Deno.test("marks the source degraded when the envelope changes shape or reports an error code", async () => {
  const shapeChanged = fakeStore();
  strictEqual(
    (await (await handlerWith(shapeChanged.store, fakeFetch(() => ({ body: JSON.stringify({ items: [] }) })).impl)(request())).json()).status,
    "degraded",
  );
  strictEqual(shapeChanged.failures.length, 1);
  strictEqual(shapeChanged.ingested.length, 0);

  const coded = fakeStore();
  const body = await (
    await handlerWith(coded.store, fakeFetch(() => ({ body: JSON.stringify({ code: "51000", details: [] }) })).impl)(request())
  ).json();
  ok(String(body.error).includes("code 51000"));
});

Deno.test("treats a network failure as degraded instead of throwing", async () => {
  const { store, failures } = fakeStore();
  const failingFetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  const response = await handlerWith(store, failingFetch)(request());
  strictEqual(response.status, 200);
  ok(failures[0]!.startsWith("okx-news request failed"));
});

Deno.test("degrades when the watermark cannot be read, without calling OKX", async () => {
  const fetched = fakeFetch(() => ({ body: okBody([]) }));
  const { store, failures } = fakeStore({ latestError: new Error("PostgREST rpc returned HTTP 500") });
  const body = await (await handlerWith(store, fetched.impl)(request())).json();
  strictEqual(body.status, "degraded");
  ok(failures[0]!.startsWith("okx-news watermark failed"));
  strictEqual(fetched.calls.length, 0);
});

Deno.test("still answers when the database write fails, and reports the failure", async () => {
  const { store, failures } = fakeStore({ ingestError: new Error("PostgREST rpc returned HTTP 500") });
  const body = await (await handlerWith(store, fakeFetch(() => ({ body: okBody([newsItem(1, NOW - 1000)]) })).impl)(request())).json();
  strictEqual(body.status, "degraded");
  ok(failures[0]!.startsWith("okx-news ingest failed"));
});

Deno.test("does not crash when recording the failure also fails", async () => {
  const { store } = fakeStore({ recordError: new Error("db down") });
  const response = await handlerWith(store, fakeFetch(() => ({ status: 500, body: "x" })).impl)(request());
  strictEqual(response.status, 200);
  strictEqual((await response.json()).error, "okx-news HTTP 500");
});

Deno.test("an empty but valid feed is a healthy poll that still refreshes the heartbeat", async () => {
  const { store, ingested } = fakeStore({ ingest: { inserted: 0, duplicates: 0 } });
  const body = await (await handlerWith(store, fakeFetch(() => ({ body: okBody([]) })).impl)(request())).json();
  strictEqual(body.status, "ok");
  deepStrictEqual(ingested, [[]]);
});

Deno.test("skips entries that the parser rejects while keeping the rest of the page", async () => {
  const details = [newsItem(1, NOW - 1000), { id: "2", cTime: String(NOW - 2000), content: "低", importance: "low" }];
  const { store, ingested } = fakeStore();
  const body = await (await handlerWith(store, fakeFetch(() => ({ body: okBody(details) })).impl)(request())).json();
  strictEqual(body.fetched, 1);
  deepStrictEqual(ingested[0]!.map((row) => row.external_id), ["1"]);
});

Deno.test("defaults to the public OKX host", () => {
  strictEqual(DEFAULT_OKX_NEWS_CONFIG.baseUrl, "https://www.okx.com");
});

Deno.test("sends no OKX auth headers when credentials are not configured", async () => {
  const fetched = fakeFetch(() => ({ body: okBody([]) }));
  const { store } = fakeStore();
  await handlerWith(store, fetched.impl)(request());
  strictEqual(fetched.headers[0]!["ok-access-key"], undefined);
  strictEqual(fetched.headers[0]!["ok-access-sign"], undefined);
});

Deno.test("signs each page request with OKX v5 headers when credentials are configured", async () => {
  const credentials = { apiKey: "key-123", apiSecret: "secret-456", passphrase: "phrase-789" };
  const fetched = fakeFetch(() => ({ body: okBody([]) }));
  const { store } = fakeStore();
  await createOkxNewsHandler({
    cronSecret: SECRET,
    store,
    config: { ...CONFIG, credentials },
    fetchImpl: fetched.impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  const [headers] = fetched.headers;
  const [url] = fetched.calls;
  const timestamp = new Date(NOW).toISOString();
  const path = `${url!.pathname}${url!.search}`;
  strictEqual(headers!["ok-access-key"], "key-123");
  strictEqual(headers!["ok-access-passphrase"], "phrase-789");
  strictEqual(headers!["ok-access-timestamp"], timestamp);
  strictEqual(
    headers!["ok-access-sign"],
    createHmac("sha256", "secret-456").update(`${timestamp}GET${path}`).digest("base64"),
  );
});

Deno.test("includes OKX's error message in the degraded reason so a missing or rejected key is visible", async () => {
  const { store, failures } = fakeStore();
  const body = await (
    await handlerWith(store, fakeFetch(() => ({ status: 401, body: JSON.stringify({ msg: "Invalid OK-ACCESS-KEY", code: "50111" }) })).impl)(request())
  ).json();
  deepStrictEqual(body, { status: "degraded", error: "okx-news HTTP 401: Invalid OK-ACCESS-KEY" });
  deepStrictEqual(failures, ["okx-news HTTP 401: Invalid OK-ACCESS-KEY"]);
});
