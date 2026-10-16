import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createRestPushStore } from "./store.ts";

interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(respond: (call: RecordedCall) => unknown) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return jsonResponse(respond(call));
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const OPTS = { supabaseUrl: "https://example.supabase.co", serviceKey: "service-key" };

describe("createRestPushStore", () => {
  it("filters eligible alerts in PostgREST before applying the limit", async () => {
    const { calls, fetchImpl } = fakeFetch(() => []);
    const store = createRestPushStore({ ...OPTS, fetchImpl });
    await store.recentAlerts("2026-10-16T00:00:00Z", 50);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    // The eligibility predicate (critical OR source_stale) must reach the
    // database; filtering in memory after a top-N query would permanently hide
    // older eligible alerts behind newer ordinary ones.
    assert.equal(url.searchParams.get("or"), "(severity.eq.critical,kind.eq.source_stale)");
    assert.equal(url.searchParams.get("limit"), "50");
    const orIndex = url.search.indexOf("or=");
    const limitIndex = url.search.indexOf("limit=");
    assert.ok(orIndex >= 0 && orIndex < limitIndex, "or filter precedes the limit");
  });

  it("pages through news events instead of a single top-N query", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ev-${i}`, title: `t${i}`, first_published_at: "x" }));
    const { calls, fetchImpl } = fakeFetch((call) => {
      const offset = Number(new URL(call.url).searchParams.get("offset") ?? "0");
      if (offset === 0) return page(100);
      if (offset === 100) return page(30);
      return [];
    });
    const store = createRestPushStore({ ...OPTS, fetchImpl });
    const events = await store.recentNewsEvents("2026-10-16T00:00:00Z", 500);
    // 130 events across two pages: the whole window is fetched, not a top-N slice.
    assert.equal(events.length, 130);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url.includes("offset=100"), true);
  });

  it("stops paging news events on the first short page", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      const offset = Number(new URL(call.url).searchParams.get("offset") ?? "0");
      return offset === 0 ? [{ id: "ev-1", title: "t", first_published_at: "x" }] : [];
    });
    const store = createRestPushStore({ ...OPTS, fetchImpl });
    const events = await store.recentNewsEvents("2026-10-16T00:00:00Z", 50);
    assert.equal(events.length, 1);
    assert.equal(calls.length, 1);
  });
});
