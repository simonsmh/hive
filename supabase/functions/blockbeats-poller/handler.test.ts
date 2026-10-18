import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { NewsIngestRow } from "./core/news.ts";
import { createBlockBeatsHandler, type BlockBeatsStore, type IngestResult } from "./handler.ts";
import { DEFAULT_BLOCKBEATS_CONFIG } from "./api.ts";
/** Same encrypted fixture as api.test.ts (kept self-contained so the deploy bundle stays clean). */
const FIXTURE = {
  requestNowMs: 1_700_000_000_000,
  responseTs: "1700000000123",
  responseNonce: "AbCdEfGhIjKlMnOp",
  keyToken: "B6/EvejvpZfyphpxMTLkVQEtvrxcP8G1IG5Jce8Rj1s=",
  data: "3fTGCwNW/UoRhs15s13fMwSFEdY+URd+JZBC7CGedLBXocF8e1QM3g9feBNeiQpIM/qUOVDdEUsSgyw2VL86n5Jl/wu6GuZMYvpqF7XpYor3BOd00fdIY66p7WSY3nU6SRdMMnjoXAYq6AcXKJ8tdgD3gUKdydCxK2tlucZYvYxQ9hYhYHwM+fwFrGkED0w5g5NYzsQLUWCYt1B0chgI0X6uYqchS1EgX7kYzNDFdkAfdymtzp+cA+fJPsgnTBkdFOR9IMZuVLfCKHNiN5uW9W9UM0o/w2/C1tEsJkVoquyJxqlMaZXn+T8k3yNx5kXnINZY97awhTfL6HK/KVJgnA==",
} as const;

function fixtureResponse(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: FIXTURE.data }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-encrypted": "true",
      "x-key-token": FIXTURE.keyToken,
      "x-timestamp": FIXTURE.responseTs,
      "x-nonce": FIXTURE.responseNonce,
    },
  });
}

const SECRET = "test-cron-secret";
const CONFIG = { ...DEFAULT_BLOCKBEATS_CONFIG };

function request(authorization: string | null = `Bearer ${SECRET}`, method = "POST"): Request {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return new Request("https://functions.test/blockbeats-poller", { method, headers });
}

function fakeStore(options: { ingest?: IngestResult; ingestError?: Error } = {}) {
  const ingested: NewsIngestRow[][] = [];
  const failures: string[] = [];
  const store: BlockBeatsStore = {
    async ingest(rows) {
      if (options.ingestError) throw options.ingestError;
      ingested.push(rows);
      return options.ingest ?? { inserted: rows.length, duplicates: 0 };
    },
    async recordFailure(error) {
      failures.push(error);
    },
  };
  return { store, ingested, failures };
}

function handler(store: BlockBeatsStore, fetchImpl: typeof fetch) {
  return createBlockBeatsHandler({
    cronSecret: SECRET,
    store,
    config: CONFIG,
    fetchImpl,
    now: () => FIXTURE.requestNowMs,
    nonce: () => "TestNonce1234567",
    log: () => {},
  });
}

Deno.test("rejects non-POST, missing secret config and bad auth", async () => {
  const { store } = fakeStore();
  const handle = handler(store, (async () => fixtureResponse()) as typeof fetch);
  strictEqual((await handle(request(`Bearer ${SECRET}`, "GET"))).status, 405);
  strictEqual((await handle(request("Bearer wrong"))).status, 401);
  strictEqual((await handle(request(null))).status, 401);

  const noSecret = createBlockBeatsHandler({ cronSecret: undefined, store, config: CONFIG, log: () => {} });
  strictEqual((await noSecret(request())).status, 500);
});

Deno.test("decrypts, maps and ingests a flash page", async () => {
  const { store, ingested, failures } = fakeStore();
  const response = await handler(store, (async () => fixtureResponse()) as typeof fetch)(request());
  strictEqual(response.status, 200);
  const body = (await response.json()) as { status: string; fetched: number; inserted: number };
  strictEqual(body.status, "ok");
  strictEqual(body.fetched, 2);
  strictEqual(body.inserted, 2);
  deepStrictEqual(failures, []);
  deepStrictEqual(ingested[0], [
    {
      external_id: "221820",
      title: "测试快讯 一",
      body: "正文一 & 更多",
      url: "https://www.theblockbeats.info/flash/221820",
      author: null,
      published_at: new Date(1792315945 * 1000).toISOString(),
      score: 1,
    },
    {
      external_id: "221819",
      title: "第二条",
      body: "正文二",
      url: "https://example.com/a",
      author: null,
      published_at: new Date(1792314263 * 1000).toISOString(),
      score: 0,
    },
  ]);
});

Deno.test("upstream HTTP failure degrades and records the failure", async () => {
  const { store, failures } = fakeStore();
  const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const response = await handler(store, fetchImpl)(request());
  strictEqual(response.status, 200);
  const body = (await response.json()) as { status: string; error: string };
  strictEqual(body.status, "degraded");
  strictEqual(body.error.includes("503"), true);
  strictEqual(failures.length, 1);
});

Deno.test("ingest failure degrades and records the failure", async () => {
  const { store, failures } = fakeStore({ ingestError: new Error("db down") });
  const response = await handler(store, (async () => fixtureResponse()) as typeof fetch)(request());
  const body = (await response.json()) as { status: string };
  strictEqual(body.status, "degraded");
  strictEqual(failures.length, 1);
});
