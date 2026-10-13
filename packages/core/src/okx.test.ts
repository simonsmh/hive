import { describe, expect, it } from "vitest";
import {
  OkxClient,
  OkxError,
  OkxRateLimitError,
  backoffDelayMs,
  parseOkxCandleRow,
  parseOkxCandles,
  parseOkxInstruments,
  parseOkxTicker,
} from "./okx.js";

const ROW_CLOSED = ["1791900780000", "83744.1", "83760", "83565.6", "83617.8", "23715.34", "237.1534", "19836746.6", "1"];
const ROW_OPEN = ["1791900840000", "83617.8", "83643.3", "83607.7", "83625.2", "1349.58", "13.4958", "1128566.9", "0"];

describe("parseOkxCandleRow", () => {
  it("maps an OKX row to a Candle with numeric fields and confirm flag", () => {
    expect(parseOkxCandleRow(ROW_CLOSED)).toEqual({
      ts: 1791900780000,
      open: 83744.1,
      high: 83760,
      low: 83565.6,
      close: 83617.8,
      volume: 23715.34,
      volCcy: 237.1534,
      confirmed: true,
    });
  });

  it("marks forming bars as unconfirmed", () => {
    expect(parseOkxCandleRow(ROW_OPEN).confirmed).toBe(false);
  });

  it("rejects short rows, non-numeric fields and inverted ranges", () => {
    expect(() => parseOkxCandleRow(["1", "2"])).toThrow(/at least 9 fields/);
    expect(() => parseOkxCandleRow(["1", "abc", "1", "1", "1", "1", "1", "1", "1"])).toThrow(/not a finite number/);
    expect(() => parseOkxCandleRow(["1", "1", "1", "2", "1", "1", "1", "1", "1"])).toThrow(/below low/);
    expect(() => parseOkxCandleRow(["1", "", "1", "1", "1", "1", "1", "1", "1"])).toThrow(/not a finite number/);
  });
});

describe("parseOkxCandles", () => {
  it("returns ascending candles and counts rejected rows instead of failing the batch", () => {
    const parsed = parseOkxCandles([ROW_CLOSED, ["bad"], ROW_OPEN]);
    expect(parsed.rejected).toBe(1);
    expect(parsed.candles.map((c) => c.ts)).toEqual([1791900780000, 1791900840000]);
  });

  it("rejects a non-array payload", () => {
    expect(() => parseOkxCandles({})).toThrow(/must be an array/);
  });
});

describe("parseOkxTicker / parseOkxInstruments", () => {
  it("parses the first ticker entry", () => {
    expect(
      parseOkxTicker([{ instId: "XAU-USDT-SWAP", last: "4177.6", ts: "1791900856968" }]),
    ).toEqual({ instId: "XAU-USDT-SWAP", last: 4177.6, ts: 1791900856968 });
  });

  it("rejects an empty ticker payload", () => {
    expect(() => parseOkxTicker([])).toThrow(/ticker data is empty/);
  });

  it("parses instrument entries and rejects malformed ones", () => {
    expect(parseOkxInstruments([{ instId: "BTC-USDT-SWAP", instType: "SWAP", state: "live" }])).toHaveLength(1);
    expect(() => parseOkxInstruments([{ instId: "X" }])).toThrow(/missing/);
  });
});

describe("OkxClient", () => {
  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  it("retries 403 and 429 with exponential backoff and then succeeds", async () => {
    const delays: number[] = [];
    const responses = [
      new Response("forbidden", { status: 403 }),
      new Response("slow down", { status: 429 }),
      jsonResponse(200, { code: "0", msg: "", data: [{ instId: "BTC-USDT-SWAP", last: "1", ts: "2" }] }),
    ];
    const client = new OkxClient({
      fetchImpl: async () => responses.shift() as Response,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const ticker = await client.getTicker("BTC-USDT-SWAP");
    expect(ticker.last).toBe(1);
    expect(delays).toEqual([backoffDelayMs(0), backoffDelayMs(1)]);
  });

  it("honours Retry-After seconds on 429", async () => {
    const delays: number[] = [];
    const responses = [
      jsonResponse(429, {}, { "retry-after": "7" }),
      jsonResponse(200, { code: "0", msg: "", data: [{ instId: "A", last: "1", ts: "2" }] }),
    ];
    const client = new OkxClient({
      fetchImpl: async () => responses.shift() as Response,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await client.getTicker("A");
    expect(delays).toEqual([7000]);
  });

  it("throws OkxRateLimitError after exhausting retries on 403", async () => {
    const client = new OkxClient({
      fetchImpl: async () => new Response("", { status: 403 }),
      sleep: async () => undefined,
      maxRetries: 2,
    });
    await expect(client.getTicker("A")).rejects.toBeInstanceOf(OkxRateLimitError);
  });

  it("does not retry on other 4xx errors", async () => {
    let calls = 0;
    const client = new OkxClient({
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 400 });
      },
      sleep: async () => undefined,
    });
    await expect(client.getTicker("A")).rejects.toBeInstanceOf(OkxError);
    expect(calls).toBe(1);
  });

  it("surfaces OKX business error codes", async () => {
    const client = new OkxClient({
      fetchImpl: async () => jsonResponse(200, { code: "51001", msg: "Instrument ID does not exist", data: [] }),
      sleep: async () => undefined,
    });
    await expect(client.getTicker("NOPE")).rejects.toThrow(/51001/);
  });

  it("requests candles with bar and limit query parameters", async () => {
    let requested = "";
    const client = new OkxClient({
      baseUrl: "https://example.test",
      fetchImpl: async (url) => {
        requested = String(url);
        return jsonResponse(200, { code: "0", msg: "", data: [ROW_CLOSED] });
      },
    });
    const result = await client.getCandles("NVDA-USDT-SWAP", "1m", 2);
    expect(result.candles).toHaveLength(1);
    const url = new URL(requested);
    expect(url.pathname).toBe("/api/v5/market/candles");
    expect(url.searchParams.get("instId")).toBe("NVDA-USDT-SWAP");
    expect(url.searchParams.get("bar")).toBe("1m");
    expect(url.searchParams.get("limit")).toBe("2");
  });
});
