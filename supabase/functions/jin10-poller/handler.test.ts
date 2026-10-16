import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { NewsIngestRow } from "./core/news.ts";
import { createJin10Handler, DEFAULT_JIN10_CONFIG, type IngestResult, type Jin10Config, type Jin10Store } from "./handler.ts";

const SECRET = "test-cron-secret";
const CONFIG: Jin10Config = { ...DEFAULT_JIN10_CONFIG };
const NOW = Date.parse("2026-10-13T12:00:00.000Z");

const flashPayload = {
  status: 200,
  data: [
    { id: 101, time: "2026-10-13 19:59:00", important: 1, data: { content: "<b>美联储</b>维持利率不变" } },
    { id: 102, time: "2026-10-13 19:58:00", data: { content: "原油库存增加" } },
  ],
};

function request(authorization: string | null = `Bearer ${SECRET}`, method = "POST"): Request {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return new Request("https://functions.test/jin10-poller", { method, headers });
}

function fakeStore(options: { ingest?: IngestResult; ingestError?: Error; recordError?: Error } = {}) {
  const ingested: NewsIngestRow[][] = [];
  const failures: string[] = [];
  const store: Jin10Store = {
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

function fakeFetch(body: string | null, init: { status?: number } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, requestInit?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(requestInit?.headers).entries());
    calls.push({ url: String(input), headers });
    return new Response(body, { status: init.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function handlerWith(overrides: { store?: Jin10Store; fetchImpl?: typeof fetch; cronSecret?: string | undefined }) {
  const { store } = fakeStore();
  return createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    now: () => NOW,
    log: () => undefined,
    ...overrides,
  });
}

Deno.test("rejects non-POST requests", async () => {
  const response = await handlerWith({ fetchImpl: fakeFetch("{}").impl })(request(`Bearer ${SECRET}`, "GET"));
  strictEqual(response.status, 405);
});

Deno.test("fails closed when EDGE_CRON_SECRET is not configured", async () => {
  const response = await handlerWith({ cronSecret: undefined })(request());
  strictEqual(response.status, 500);
});

Deno.test("rejects a missing or wrong bearer token before any upstream call", async () => {
  const fetched = fakeFetch(JSON.stringify(flashPayload));
  const handle = handlerWith({ fetchImpl: fetched.impl });
  strictEqual((await handle(request(null))).status, 401);
  strictEqual((await handle(request("Bearer wrong"))).status, 401);
  strictEqual(fetched.calls.length, 0);
});

Deno.test("polls with the web client headers and ingests normalised rows", async () => {
  const fetched = fakeFetch(JSON.stringify(flashPayload));
  const { store, ingested } = fakeStore({ ingest: { inserted: 2, duplicates: 0 } });
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: fetched.impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  strictEqual(response.status, 200);
  const body = await response.json();
  strictEqual(body.status, "ok");
  strictEqual(body.fetched, 2);
  strictEqual(body.inserted, 2);

  strictEqual(fetched.calls.length, 1);
  ok(fetched.calls[0]!.url.startsWith("https://flash-api.jin10.com/get_flash_list?"));
  strictEqual(fetched.calls[0]!.headers["x-app-id"], "bVBF4FyRTn5NJF5n");
  strictEqual(fetched.calls[0]!.headers["x-version"], "1.0.0");
  strictEqual(fetched.calls[0]!.headers["referer"], "https://www.jin10.com/");

  const rows = ingested[0]!;
  deepStrictEqual(rows.map((r) => r.external_id), ["101", "102"]);
  strictEqual(rows[0]!.score, 1);
  strictEqual(rows[0]!.body, "美联储维持利率不变");
});

Deno.test("reports a degraded source on an upstream HTTP error and records the failure", async () => {
  const fetched = fakeFetch("blocked", { status: 502 });
  const { store, failures, ingested } = fakeStore();
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: fetched.impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  strictEqual(response.status, 200);
  deepStrictEqual(await response.json(), { status: "degraded", error: "jin10 HTTP 502" });
  deepStrictEqual(failures, ["jin10 HTTP 502"]);
  strictEqual(ingested.length, 0);
});

Deno.test("treats an HTML block page as a format change rather than an empty feed", async () => {
  const { store, failures } = fakeStore();
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: fakeFetch("<html>Access denied</html>").impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  const body = await response.json();
  strictEqual(body.status, "degraded");
  ok(String(body.error).includes("not JSON"));
  strictEqual(failures.length, 1);
});

Deno.test("marks the source degraded when the envelope changes shape", async () => {
  const { store, failures, ingested } = fakeStore();
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: fakeFetch(JSON.stringify({ result: { items: [] } })).impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  strictEqual((await response.json()).status, "degraded");
  strictEqual(failures.length, 1);
  strictEqual(ingested.length, 0);
});

Deno.test("treats a network failure as degraded instead of throwing", async () => {
  const { store, failures } = fakeStore();
  const failingFetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: failingFetch,
    now: () => NOW,
    log: () => undefined,
  })(request());

  strictEqual(response.status, 200);
  ok(failures[0]!.startsWith("jin10 request failed"));
});

Deno.test("still answers when the database write fails, and reports the failure", async () => {
  const { store, failures } = fakeStore({ ingestError: new Error("PostgREST rpc returned HTTP 500") });
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: fakeFetch(JSON.stringify(flashPayload)).impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  strictEqual((await response.json()).status, "degraded");
  ok(failures[0]!.startsWith("jin10 ingest failed"));
});

Deno.test("does not crash when recording the failure also fails", async () => {
  const { store } = fakeStore({ recordError: new Error("db down") });
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: fakeFetch("blocked", { status: 403 }).impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  strictEqual(response.status, 200);
  strictEqual((await response.json()).error, "jin10 HTTP 403");
});

Deno.test("an empty but valid feed is a healthy poll", async () => {
  const { store, ingested } = fakeStore({ ingest: { inserted: 0, duplicates: 0 } });
  const response = await createJin10Handler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl: fakeFetch(JSON.stringify({ status: 200, data: [] })).impl,
    now: () => NOW,
    log: () => undefined,
  })(request());

  strictEqual((await response.json()).status, "ok");
  deepStrictEqual(ingested, [[]]);
});
