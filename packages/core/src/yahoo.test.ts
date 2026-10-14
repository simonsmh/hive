import { describe, expect, it } from "vitest";
import {
  DEFAULT_YAHOO_BASE_URL,
  parseYahooChart,
  YAHOO_SYMBOL_PATTERN,
  YAHOO_USER_AGENT,
  YahooClient,
  YahooError,
  YahooParseError,
  YahooRateLimitError,
} from "./yahoo.js";

const sec = (iso: string) => Date.parse(iso) / 1000;

interface BlockOverrides {
  timestamp?: unknown[] | null;
  open?: unknown[];
  high?: unknown[];
  low?: unknown[];
  close?: unknown[];
  volume?: unknown[] | null;
  gmtoffset?: number;
}

function chartBody(block: BlockOverrides = {}) {
  const timestamps = block.timestamp === undefined ? [sec("2026-10-13T13:30:00Z"), sec("2026-10-13T13:31:00Z"), sec("2026-10-13T13:32:00Z")] : block.timestamp;
  const quote: Record<string, unknown[]> = {
    open: block.open ?? [100, 101, 102],
    high: block.high ?? [101, 102, 103],
    low: block.low ?? [99, 100, 101],
    close: block.close ?? [100.5, 101.5, 102.5],
  };
  if (block.volume !== null) quote.volume = block.volume ?? [10, 20, 30];
  return {
    chart: {
      result: [
        {
          meta: { symbol: "NVDA", gmtoffset: block.gmtoffset ?? -14400, exchangeTimezoneName: "America/New_York" },
          timestamp: timestamps,
          indicators: { quote: [quote], adjclose: [{ adjclose: [] }] },
        },
      ],
      error: null,
    },
  };
}

const NOW = Date.parse("2026-10-13T14:00:00Z");

describe("parseYahooChart (1m)", () => {
  it("maps bars to candles with the newest bar as the quote, confirmed by bar end time", () => {
    const parsed = parseYahooChart(chartBody(), { interval: "1m", nowMs: NOW });
    expect(parsed.rejected).toBe(0);
    expect(parsed.candles).toEqual([
      { ts: sec("2026-10-13T13:30:00Z") * 1000, open: 100, high: 101, low: 99, close: 100.5, volume: 10, volCcy: 0, confirmed: true },
      { ts: sec("2026-10-13T13:31:00Z") * 1000, open: 101, high: 102, low: 100, close: 101.5, volume: 20, volCcy: 0, confirmed: true },
      { ts: sec("2026-10-13T13:32:00Z") * 1000, open: 102, high: 103, low: 101, close: 102.5, volume: 30, volCcy: 0, confirmed: true },
    ]);
    expect(parsed.quote).toEqual({ price: 102.5, ts: sec("2026-10-13T13:32:00Z") * 1000 });
  });

  it("marks the bar still in progress as unconfirmed", () => {
    const parsed = parseYahooChart(chartBody(), { interval: "1m", nowMs: Date.parse("2026-10-13T13:32:30Z") });
    expect(parsed.candles.map((c) => c.confirmed)).toEqual([true, true, false]);
  });

  it("skips bars with no trades and counts malformed ones without failing the response", () => {
    const parsed = parseYahooChart(
      chartBody({
        open: [100, null, 102],
        high: [101, null, 103],
        low: [99, null, 101],
        close: [100.5, null, 102.5],
        volume: [10, null, 30],
      }),
      { interval: "1m", nowMs: NOW },
    );
    expect(parsed.candles.map((c) => c.ts)).toEqual([sec("2026-10-13T13:30:00Z") * 1000, sec("2026-10-13T13:32:00Z") * 1000]);
    expect(parsed.rejected).toBe(0);

    const inverted = parseYahooChart(chartBody({ high: [101, 102, 90] }), { interval: "1m", nowMs: NOW });
    expect(inverted.rejected).toBe(1);
    expect(inverted.candles).toHaveLength(2);
  });

  it("treats a partially null bar as malformed and a null volume as zero", () => {
    const parsed = parseYahooChart(chartBody({ close: [100.5, null, 102.5], volume: [null, 20, 30] }), { interval: "1m", nowMs: NOW });
    expect(parsed.rejected).toBe(1);
    expect(parsed.candles[0]?.volume).toBe(0);
  });

  it("returns no quote when every bar is empty", () => {
    const parsed = parseYahooChart(chartBody({ open: [null], high: [null], low: [null], close: [null], timestamp: [sec("2026-10-13T13:30:00Z")], volume: [null] }), {
      interval: "1m",
      nowMs: NOW,
    });
    expect(parsed).toEqual({ candles: [], quote: null, rejected: 0 });
  });

  it("returns empty output, not an error, when the range has no timestamps", () => {
    expect(parseYahooChart(chartBody({ timestamp: [] }), { interval: "1m", nowMs: NOW })).toEqual({ candles: [], quote: null, rejected: 0 });
  });

  it("sorts out-of-order bars and keeps one bar per timestamp", () => {
    const parsed = parseYahooChart(
      chartBody({
        timestamp: [sec("2026-10-13T13:31:00Z"), sec("2026-10-13T13:30:00Z"), sec("2026-10-13T13:31:00Z")],
        close: [101.5, 100.5, 101.9],
      }),
      { interval: "1m", nowMs: NOW },
    );
    expect(parsed.candles.map((c) => c.close)).toEqual([100.5, 101.9]);
  });
});

describe("parseYahooChart (1d)", () => {
  it("keys daily bars by 00:00 UTC of the exchange-local calendar date", () => {
    const parsed = parseYahooChart(chartBody({ timestamp: [sec("2026-10-13T13:30:00Z")], open: [100], high: [101], low: [99], close: [100.5], volume: [5] }), {
      interval: "1d",
      nowMs: Date.parse("2026-10-14T13:00:00Z"),
    });
    expect(parsed.candles).toEqual([
      { ts: Date.parse("2026-10-13T00:00:00Z"), open: 100, high: 101, low: 99, close: 100.5, volume: 5, volCcy: 0, confirmed: true },
    ]);
    expect(parsed.quote).toBeNull();
  });

  it("leaves today's bar unconfirmed until its calendar day has ended", () => {
    const parsed = parseYahooChart(chartBody({ timestamp: [sec("2026-10-13T13:30:00Z")], open: [100], high: [101], low: [99], close: [100.5] }), {
      interval: "1d",
      nowMs: Date.parse("2026-10-13T20:00:00Z"),
    });
    expect(parsed.candles[0]?.confirmed).toBe(false);
  });

  it("uses the exchange offset, so a bar that is still the 13th in UTC but the 14th locally lands on the 14th", () => {
    const parsed = parseYahooChart(
      chartBody({ timestamp: [sec("2026-10-13T20:00:00Z")], open: [1], high: [1], low: [1], close: [1], gmtoffset: 28800 }),
      { interval: "1d", nowMs: NOW },
    );
    expect(parsed.candles[0]?.ts).toBe(Date.parse("2026-10-14T00:00:00Z"));
  });
});

describe("parseYahooChart errors", () => {
  it("turns chart.error into a YahooError carrying Yahoo's code and description", () => {
    const payload = { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } };
    expect(() => parseYahooChart(payload, { interval: "1m", nowMs: NOW })).toThrow(
      new YahooError("yahoo chart error Not Found: No data found, symbol may be delisted"),
    );
  });

  it("rejects a payload without a chart object or result", () => {
    expect(() => parseYahooChart({}, { interval: "1m", nowMs: NOW })).toThrow(YahooParseError);
    expect(() => parseYahooChart({ chart: { result: [] } }, { interval: "1m", nowMs: NOW })).toThrow(/has no result/);
  });

  it("rejects arrays that do not line up with the timestamps", () => {
    expect(() => parseYahooChart(chartBody({ close: [1, 2] }), { interval: "1m", nowMs: NOW })).toThrow(/close does not match/);
  });

  it("rejects timestamps that arrive without a quote block", () => {
    const body = chartBody();
    (body.chart.result[0] as { indicators: unknown }).indicators = {};
    expect(() => parseYahooChart(body, { interval: "1m", nowMs: NOW })).toThrow(/no quote block/);
  });
});

describe("YAHOO_SYMBOL_PATTERN", () => {
  it("accepts the symbol forms used in symbol_map and rejects anything that could alter the URL", () => {
    for (const symbol of ["NVDA", "BZ=F", "XAUUSD=X", "BTC-USD", "^GSPC", "BRK-B", "0700.HK"]) {
      expect(YAHOO_SYMBOL_PATTERN.test(symbol)).toBe(true);
    }
    for (const symbol of ["", "NVDA/../x", "NVDA?x=1", "NVDA NVDA", "a".repeat(25)]) {
      expect(YAHOO_SYMBOL_PATTERN.test(symbol)).toBe(false);
    }
  });
});

describe("YahooClient", () => {
  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  it("requests one-minute bars with pre/post-market and a browser user agent, without credentials", async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    const client = new YahooClient({
      baseUrl: "https://yahoo.test",
      fetchImpl: async (input, init) => {
        requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
        return jsonResponse(200, chartBody());
      },
    });
    const chart = await client.getIntraday("BZ=F");
    expect(chart.quote?.price).toBe(102.5);
    const request = requests[0];
    if (!request) throw new Error("no request was sent");
    expect(request.url.origin + request.url.pathname).toBe("https://yahoo.test/v8/finance/chart/BZ%3DF");
    expect(request.url.searchParams.get("interval")).toBe("1m");
    expect(request.url.searchParams.get("range")).toBe("1d");
    expect(request.url.searchParams.get("includePrePost")).toBe("true");
    expect(request.headers.get("user-agent")).toBe(YAHOO_USER_AGENT);
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
  });

  it("requests daily bars over three months at 1d resolution", async () => {
    let url = "";
    const client = new YahooClient({
      baseUrl: "https://yahoo.test",
      fetchImpl: async (input) => {
        url = String(input);
        return jsonResponse(200, chartBody({ timestamp: [sec("2026-10-13T13:30:00Z")], open: [1], high: [1], low: [1], close: [1] }));
      },
    });
    const chart = await client.getDaily("NVDA");
    expect(chart.quote).toBeNull();
    expect(new URL(url).searchParams.get("interval")).toBe("1d");
    expect(new URL(url).searchParams.get("range")).toBe("3mo");
  });

  it("uses the public query1 host by default", () => {
    expect(DEFAULT_YAHOO_BASE_URL).toBe("https://query1.finance.yahoo.com");
  });

  it("does not send a request for a symbol outside the allowed pattern", async () => {
    let calls = 0;
    const client = new YahooClient({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, chartBody());
      },
    });
    await expect(client.getIntraday("NVDA/../../x")).rejects.toThrow(/invalid yahoo symbol/);
    expect(calls).toBe(0);
  });

  it("retries 429 honouring Retry-After and then succeeds", async () => {
    const delays: number[] = [];
    const responses = [jsonResponse(429, {}, { "retry-after": "2" }), jsonResponse(200, chartBody())];
    const client = new YahooClient({
      fetchImpl: async () => responses.shift() as Response,
      sleep: async (ms) => {
        delays.push(ms);
      },
      maxBackoffMs: 10_000,
    });
    await client.getIntraday("NVDA");
    expect(delays).toEqual([2000]);
  });

  it("classifies 403 and 429 as rate limiting after the retries run out", async () => {
    const client = new YahooClient({
      fetchImpl: async () => new Response("Too Many Requests", { status: 429 }),
      sleep: async () => undefined,
      maxRetries: 1,
    });
    await expect(client.getIntraday("NVDA")).rejects.toBeInstanceOf(YahooRateLimitError);

    const blocked = new YahooClient({ fetchImpl: async () => new Response("", { status: 403 }), sleep: async () => undefined, maxRetries: 0 });
    await expect(blocked.getDaily("NVDA")).rejects.toBeInstanceOf(YahooRateLimitError);
  });

  it("does not retry a 404 and reports Yahoo's description, not the raw body", async () => {
    let calls = 0;
    const client = new YahooClient({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(404, { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } });
      },
      sleep: async () => undefined,
    });
    const failure = client.getIntraday("NVDA");
    await expect(failure).rejects.toMatchObject({ name: "YahooError", status: 404 });
    await expect(failure).rejects.toThrow("yahoo chart NVDA returned HTTP 404: Not Found: No data found, symbol may be delisted");
    expect(calls).toBe(1);
  });

  it("retries 5xx and network errors, then reports a plain YahooError when they persist", async () => {
    let calls = 0;
    const client = new YahooClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("socket reset");
        return new Response("oops", { status: 503 });
      },
      sleep: async () => undefined,
      maxRetries: 2,
    });
    const error = await client.getIntraday("NVDA").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YahooError);
    expect(error).not.toBeInstanceOf(YahooRateLimitError);
    expect(calls).toBe(3);
  });

  it("rejects a 200 response that is not JSON", async () => {
    const client = new YahooClient({ fetchImpl: async () => new Response("<html>consent</html>", { status: 200 }), sleep: async () => undefined });
    await expect(client.getIntraday("NVDA")).rejects.toThrow(YahooParseError);
  });

  it("paces consecutive requests from one client", async () => {
    let clock = 1_000;
    const delays: number[] = [];
    const client = new YahooClient({
      fetchImpl: async () => jsonResponse(200, chartBody()),
      sleep: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
      now: () => clock,
      minIntervalMs: 300,
    });
    await client.getIntraday("A");
    await client.getIntraday("B");
    expect(delays).toEqual([300]);
  });
});
