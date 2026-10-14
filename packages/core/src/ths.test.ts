import { describe, expect, it } from "vitest";
import {
  ThsClient,
  ThsError,
  directionOf,
  errorKindForCode,
  isThsCode,
  parseSnapshot,
  parseTradingDays,
  quoteOf,
  unwrapEnvelope,
} from "./ths.js";

const API_KEY = "hithink-test-key-do-not-leak";

const snapshotEnvelope = {
  code: 0,
  message: "success",
  request_id: "req-1",
  data: {
    timestamp: 1784275991000,
    total: 2,
    item: [
      {
        thscode: "600519.SH",
        ticker: "600519",
        volume: 3098875,
        turnover: 3937375200,
        last_price: 1277.8,
        price_change: 21.8,
        price_change_ratio_pct: 1.735669,
        open_price: 1252.08,
        high_price: 1282,
        low_price: 1250.21,
        prev_price: 1256,
      },
    ],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("unwrapEnvelope", () => {
  it("returns data for code 0 and keeps the request id", () => {
    expect(unwrapEnvelope(snapshotEnvelope).requestId).toBe("req-1");
    expect((unwrapEnvelope(snapshotEnvelope).data as { total: number }).total).toBe(2);
  });

  it("maps business codes to retry and backoff classes", () => {
    const kind = (code: number) => {
      try {
        unwrapEnvelope({ code, message: "x", request_id: null, data: null });
      } catch (error) {
        return (error as ThsError).kind;
      }
      return "none";
    };
    expect(kind(4001)).toBe("rate_limited");
    expect(kind(2001)).toBe("auth");
    expect(kind(2003)).toBe("auth");
    expect(kind(3002)).toBe("not_ready");
    expect(kind(3004)).toBe("unsupported");
    expect(kind(1003)).toBe("invalid_request");
    expect(kind(5002)).toBe("server");
    expect(kind(9999)).toBe("upstream");
  });

  it("marks only rate limits, server errors and network errors as retryable", () => {
    expect(new ThsError("x", errorKindForCode(4001)).retryable).toBe(true);
    expect(new ThsError("x", "server").retryable).toBe(true);
    expect(new ThsError("x", "network").retryable).toBe(true);
    expect(new ThsError("x", "auth").retryable).toBe(false);
    expect(new ThsError("x", "not_ready").retryable).toBe(false);
  });

  it("rejects a body without a numeric code", () => {
    expect(() => unwrapEnvelope({ data: {} })).toThrow(ThsError);
  });
});

describe("parseSnapshot and quoteOf", () => {
  it("reads timestamp, total and item rows from the verified shape", () => {
    const parsed = parseSnapshot(snapshotEnvelope.data);
    expect(parsed.timestamp).toBe(1784275991000);
    expect(parsed.total).toBe(2);
    expect(quoteOf(parsed.items[0] as Record<string, unknown>)).toEqual({ thscode: "600519.SH", lastPrice: 1277.8 });
  });

  it("returns a null timestamp when upstream reports no valid data", () => {
    expect(parseSnapshot({ timestamp: null, total: 0, item: [] }).timestamp).toBeNull();
  });

  it("rejects non-positive and non-finite prices", () => {
    expect(quoteOf({ thscode: "000001.SH", last_price: 0 })).toBeNull();
    expect(quoteOf({ thscode: "000001.SH", last_price: "3388" })).toBeNull();
    expect(quoteOf({ thscode: "", last_price: 3388 })).toBeNull();
  });

  it("requires an item array", () => {
    expect(() => parseSnapshot({ timestamp: 1, total: 1 })).toThrow(ThsError);
  });
});

describe("directionOf", () => {
  it("classifies by the sign of price_change_ratio_pct", () => {
    expect(directionOf({ price_change_ratio_pct: 0.4 })).toBe("up");
    expect(directionOf({ price_change_ratio_pct: -0.1 })).toBe("down");
    expect(directionOf({ price_change_ratio_pct: 0 })).toBe("flat");
    expect(directionOf({})).toBe("unknown");
  });
});

describe("parseTradingDays", () => {
  it("accepts date strings, compact dates and millisecond timestamps", () => {
    const days = parseTradingDays({
      item: ["2026-10-14", "20261013", { date_ms: Date.parse("2026-10-11T16:00:00Z") }],
    });
    expect([...days].sort()).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
  });

  it("throws when no entry is parseable so the caller falls back to weekdays", () => {
    expect(() => parseTradingDays({ item: [{ foo: 1 }] })).toThrow(ThsError);
    expect(() => parseTradingDays({ item: [] })).toThrow(ThsError);
  });
});

describe("isThsCode", () => {
  it("accepts index and A-share thscodes and rejects bare tickers", () => {
    expect(isThsCode("000001.SH")).toBe(true);
    expect(isThsCode("600519.SH")).toBe(true);
    expect(isThsCode("886042.TI")).toBe(true);
    expect(isThsCode("600519")).toBe(false);
    expect(isThsCode("600519.sh")).toBe(false);
  });
});

describe("ThsClient", () => {
  function clientWith(responses: Array<Response | Error>) {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const sleeps: number[] = [];
    let index = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      const next = responses[index];
      index += 1;
      if (next instanceof Error) throw next;
      return next as Response;
    };
    const client = new ThsClient({
      apiKey: API_KEY,
      baseUrl: "https://fuyao.test",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 3,
    });
    return { client, calls, sleeps };
  }

  it("sends the key only in X-api-key and builds the batched thscodes query", async () => {
    const { client, calls } = clientWith([jsonResponse(snapshotEnvelope)]);
    await client.stockSnapshot(["600519.SH", "000858.SZ"]);
    expect(calls[0]?.url).toBe("https://fuyao.test/api/a-share/prices/snapshot?thscodes=600519.SH%2C000858.SZ");
    expect(calls[0]?.headers.get("x-api-key")).toBe(API_KEY);
  });

  it("retries rate limits with exponential backoff and then succeeds", async () => {
    const limited = () => jsonResponse({ code: 4001, message: "rate limited", request_id: "r", data: null });
    const { client, calls, sleeps } = clientWith([limited(), limited(), jsonResponse(snapshotEnvelope)]);
    const snapshot = await client.indexSnapshot(["000001.SH"]);
    expect(snapshot.timestamp).toBe(1784275991000);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after maxRetries on repeated rate limits, with the error kind preserved", async () => {
    const limited = () => jsonResponse({ code: 4001, message: "rate limited", request_id: null, data: null });
    const { client, calls } = clientWith([limited(), limited(), limited(), limited(), limited()]);
    await expect(client.indexSnapshot(["000001.SH"])).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toHaveLength(4);
  });

  it("does not retry auth or invalid-parameter errors", async () => {
    const { client, calls } = clientWith([jsonResponse({ code: 2003, message: "Invalid or revoked API key", request_id: null, data: null })]);
    await expect(client.stockSnapshot(["600519.SH"])).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors and never puts the key into an error message", async () => {
    const { client } = clientWith([new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up")]);
    let thrown: unknown = null;
    try {
      await client.stockSnapshot(["600519.SH"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ThsError);
    expect((thrown as ThsError).kind).toBe("network");
    expect((thrown as ThsError).message).not.toContain(API_KEY);
  });

  it("treats HTTP 5xx as a retryable server error", async () => {
    const { client, calls } = clientWith([new Response("bad gateway", { status: 502 }), jsonResponse(snapshotEnvelope)]);
    await client.stockSnapshot(["600519.SH"]);
    expect(calls).toHaveLength(2);
  });

  it("reports a non-JSON body as malformed without retrying", async () => {
    const { client, calls } = clientWith([new Response("<html>", { status: 200 })]);
    await expect(client.stockSnapshot(["600519.SH"])).rejects.toMatchObject({ kind: "malformed" });
    expect(calls).toHaveLength(1);
  });
});
