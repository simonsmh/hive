import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createGoldApiCollectorHandler, type GoldApiCollectorStore } from "./handler.ts";

function auth(secret: string): HeadersInit {
  return { authorization: `Bearer ${secret}` };
}

function memStore(): GoldApiCollectorStore & { quotes: { price: number; ts: number }[]; failures: string[] } {
  const quotes: { price: number; ts: number }[] = [];
  const failures: string[] = [];
  return {
    quotes,
    failures,
    beginRun: () => Promise.resolve(true),
    finishRun: () => Promise.resolve(),
    upsertQuote: (_symbol, _source, quote) => {
      quotes.push(quote);
      return Promise.resolve();
    },
    recordSourceSuccess: () => Promise.resolve(),
    recordSourceFailure: (_source, error) => {
      failures.push(error);
      return Promise.resolve();
    },
  };
}

const nowMs = Date.parse("2026-11-18T13:23:30Z");
const body = {
  currency: "USD",
  name: "Gold",
  price: 3769.120117,
  symbol: "XAU",
  updatedAt: "2026-11-18T13:23:30Z",
};

Deno.test("rejects unauthorized ticks", async () => {
  const store = memStore();
  const handler = createGoldApiCollectorHandler({
    cronSecret: "secret",
    store,
    client: { fetchSpotUsd: () => Promise.resolve(body) },
    now: () => nowMs,
  });
  const response = await handler(new Request("https://example/functions/v1/gold-api-collector", { method: "POST" }));
  assertEquals(response.status, 401);
  assertEquals(store.quotes.length, 0);
});

Deno.test("writes a USD spot snapshot under XAUUSD / gold-api and does not invent candles", async () => {
  const store = memStore();
  const handler = createGoldApiCollectorHandler({
    cronSecret: "secret",
    store,
    client: { fetchSpotUsd: () => Promise.resolve(body) },
    now: () => nowMs,
  });
  const response = await handler(
    new Request("https://example/functions/v1/gold-api-collector", { method: "POST", headers: auth("secret") }),
  );
  assertEquals(response.status, 200);
  const json = await response.json();
  assertEquals(json.source, "gold-api");
  assertEquals(json.symbol, "XAUUSD");
  assertEquals(json.price, 3769.120117);
  assertEquals(store.quotes, [{ price: 3769.120117, ts: nowMs }]);
});

Deno.test("does not write a stale snapshot", async () => {
  const store = memStore();
  const handler = createGoldApiCollectorHandler({
    cronSecret: "secret",
    store,
    client: {
      fetchSpotUsd: () => Promise.resolve({ ...body, updatedAt: "2026-11-18T13:00:00Z" }),
    },
    now: () => nowMs,
  });
  const response = await handler(
    new Request("https://example/functions/v1/gold-api-collector", { method: "POST", headers: auth("secret") }),
  );
  assertEquals(response.status, 500);
  assertEquals(store.quotes.length, 0);
  assertEquals(store.failures.length, 1);
});
