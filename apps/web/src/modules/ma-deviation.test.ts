import { describe, expect, it, vi } from "vitest";
import {
  MA_DEVIATION_ASHARE_SYMBOLS,
  MA_DEVIATION_SYMBOLS,
  MA_DEVIATION_YAHOO_SYMBOLS,
  buildRow,
  computeDeviations,
  loadMaDeviationBoard,
  parseSinaMinuteJsonp,
  parseYahooMinuteChart,
  weightedDeviation,
} from "./ma-deviation";

/** 25 flat bars then a 5-bar jump: W > 0, W_prev == 0 (deviations are 0 until the jump). */
const FLAT_THEN_JUMP_OKX = [...Array.from({ length: 25 }, () => 100), ...Array.from({ length: 5 }, () => 110)];
const FLAT_THEN_JUMP_SINA = [...Array.from({ length: 25 }, () => 10), ...Array.from({ length: 5 }, () => 11)];
const FLAT_THEN_JUMP_YAHOO = [...Array.from({ length: 25 }, () => 20), ...Array.from({ length: 5 }, () => 22)];

function okxResponse(closes: number[]) {
  // OKX returns newest-first rows: [ts, open, high, low, close, ...].
  // The newest row (largest ts) carries the last close, so after the
  // loader sorts ascending by ts the closes come back in `closes` order.
  const data = closes.map((_, i) => [
    String((closes.length - i) * 60_000),
    "0",
    "0",
    "0",
    String(closes[closes.length - 1 - i]),
  ]);
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: "0", data }),
    text: async () => "",
  };
}

function sinaJsonp(closes: number[]): string {
  const bars = closes.map((close, i) => {
    const minutes = 9 * 60 + 31 + i; // 09:31 onward, Beijing time
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return {
      day: `2026-11-05 ${hh}:${mm}:00`,
      open: String(close),
      high: String(close),
      low: String(close),
      close: String(close),
      volume: "100",
      amount: "1000",
    };
  });
  return `/*<script>location.href='//sina.com';</script>*/\nvar=(${JSON.stringify(bars)})`;
}

function yahooResponse(closes: number[]) {
  // Yahoo v8 chart: { chart: { result: [{ timestamp (seconds), indicators:
  // { quote: [{ close }] } }] } }. Timestamps ascend; closes align by index.
  const start = Date.UTC(2026, 10, 5, 13, 30, 0) / 1000;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: closes.map((_, i) => start + i * 60),
            indicators: { quote: [{ close: closes }] },
          },
        ],
      },
    }),
    text: async () => "",
  };
}

function mockFetch(
  okxCloses: number[],
  sinaCloses: number[],
  sinaFailure: "throw" | "http500" | null = null,
  yahooCloses: number[] = FLAT_THEN_JUMP_YAHOO,
): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes("okx.com")) return okxResponse(okxCloses);
    if (url.includes("query1.finance.yahoo.com")) return yahooResponse(yahooCloses);
    if (url.includes("quotes.sina.cn")) {
      if (sinaFailure === "throw") throw new Error("sina down");
      if (sinaFailure === "http500") {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("sina answers JSONP, not JSON");
        },
        text: async () => sinaJsonp(sinaCloses),
      };
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

function assertNoNaN(value: unknown): void {
  if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) assertNoNaN(child);
  }
}

describe("loadMaDeviationBoard", () => {
  it("uses null (not NaN) for failed instruments, so JSON round-trips without crashing the panel", async () => {
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const board = await loadMaDeviationBoard(failingFetch);
    expect(board.rows.length).toBe(
      MA_DEVIATION_SYMBOLS.length +
        MA_DEVIATION_ASHARE_SYMBOLS.length +
        MA_DEVIATION_YAHOO_SYMBOLS.length,
    );
    expect(board.rows.every((row) => row.lastClose === null)).toBe(true);
    expect(board.groups.every((group) => group.meanW === null && group.count === 0)).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(board)) as typeof board;
    expect(roundTripped.rows.every((row) => row.lastClose === null)).toBe(true);
    assertNoNaN(roundTripped);
  });

  it("loads A-share rows via Sina with market 'ashare' and a correct W", async () => {
    const board = await loadMaDeviationBoard(mockFetch(FLAT_THEN_JUMP_OKX, FLAT_THEN_JUMP_SINA));
    expect(board.rows.length).toBe(
      MA_DEVIATION_SYMBOLS.length +
        MA_DEVIATION_ASHARE_SYMBOLS.length +
        MA_DEVIATION_YAHOO_SYMBOLS.length,
    );

    const ashare = board.rows.filter((row) => row.market === "ashare");
    expect(ashare.length).toBe(MA_DEVIATION_ASHARE_SYMBOLS.length);
    expect(ashare.map((row) => row.symbol)).toEqual(
      MA_DEVIATION_ASHARE_SYMBOLS.map((entry) => entry.symbol),
    );
    // 6-digit display code, Sina code in instId (513000 is Shanghai-listed).
    const nikkei = ashare.find((row) => row.symbol === "513000");
    expect(nikkei?.instId).toBe("sh513000");
    for (const row of ashare) {
      expect(row.lastClose).toBe(11);
      // Deviations are scale-invariant: same W as the OKX flat-then-jump shape.
      expect(row.w).toBeGreaterThan(7.9);
      expect(row.w).toBeLessThan(8.1);
      expect(row.wPrev).toBe(0);
      expect(row.wChange).toBeCloseTo(row.w as number, 6);
    }
    // Last Sina bar is 10:00 Beijing; ts is UTC ms.
    const first = ashare[0];
    expect(first?.lastTs).toBe(Date.UTC(2026, 10, 5, 10, 0, 0) - 8 * 60 * 60_000);

    const okx = board.rows.filter((row) => row.market === "okx");
    expect(okx.length).toBe(MA_DEVIATION_SYMBOLS.length + MA_DEVIATION_YAHOO_SYMBOLS.length);
    expect(okx.every((row) => row.w !== null && row.w > 0)).toBe(true);

    // Per-market stats are never mixed.
    const okxGroup = board.groups.find((group) => group.market === "okx");
    const ashareGroup = board.groups.find((group) => group.market === "ashare");
    expect(okxGroup?.count).toBe(MA_DEVIATION_SYMBOLS.length + MA_DEVIATION_YAHOO_SYMBOLS.length);
    expect(ashareGroup?.count).toBe(MA_DEVIATION_ASHARE_SYMBOLS.length);
    expect(okxGroup?.meanW).toBeCloseTo(8.0236, 3);
    expect(ashareGroup?.meanW).toBeCloseTo(8.0236, 3);
    expect(okxGroup?.positiveShare).toBe(1);
    expect(ashareGroup?.positiveShare).toBe(1);

    // Rows are grouped by market, each ranked by W (all equal here, so the
    // OKX block simply precedes the A-share block).
    const okxBlock = MA_DEVIATION_SYMBOLS.length + MA_DEVIATION_YAHOO_SYMBOLS.length;
    const markets = board.rows.map((row) => row.market);
    expect(markets.slice(0, okxBlock).every((m) => m === "okx")).toBe(true);
    expect(markets.slice(okxBlock).every((m) => m === "ashare")).toBe(true);
    assertNoNaN(JSON.parse(JSON.stringify(board)) as unknown);
  });

  it("covers UVXY perpetual and VIX (Yahoo) in the OKX group, same W caliber", async () => {
    const board = await loadMaDeviationBoard(mockFetch(FLAT_THEN_JUMP_OKX, FLAT_THEN_JUMP_SINA));
    const okx = board.rows.filter((row) => row.market === "okx");
    expect(okx.length).toBe(MA_DEVIATION_SYMBOLS.length + MA_DEVIATION_YAHOO_SYMBOLS.length);

    const uvxy = okx.find((row) => row.symbol === "UVXY");
    expect(uvxy?.instId).toBe("UVXY-USDT-SWAP");
    expect(uvxy?.w).toBeGreaterThan(7.9);
    expect(uvxy?.w).toBeLessThan(8.1);

    // VIX is an index, not an OKX product: its 1m bars come from Yahoo.
    const vix = okx.find((row) => row.symbol === "VIX");
    expect(vix?.instId).toBe("^VIX");
    expect(vix?.w).toBeGreaterThan(7.9);
    expect(vix?.w).toBeLessThan(8.1);
  });

  it("covers BTC, ETH, SOL and OKB perpetuals on the OKX side, same W caliber", async () => {
    const board = await loadMaDeviationBoard(mockFetch(FLAT_THEN_JUMP_OKX, FLAT_THEN_JUMP_SINA));
    const okx = board.rows.filter((row) => row.market === "okx");
    expect(okx.length).toBe(MA_DEVIATION_SYMBOLS.length + MA_DEVIATION_YAHOO_SYMBOLS.length);
    for (const [symbol, instId] of [
      ["BTC", "BTC-USDT-SWAP"],
      ["ETH", "ETH-USDT-SWAP"],
      ["SOL", "SOL-USDT-SWAP"],
      ["OKB", "OKB-USDT-SWAP"],
    ] as const) {
      const row = okx.find((entry) => entry.symbol === symbol);
      expect(row?.instId).toBe(instId);
      // Same caliber as every other OKX row: forming-bar W from 1m closes.
      expect(row?.w).toBeGreaterThan(7.9);
      expect(row?.w).toBeLessThan(8.1);
    }
  });

  it("falls back to all-null A-share rows when Sina throws, and stays JSON-safe", async () => {
    const board = await loadMaDeviationBoard(mockFetch(FLAT_THEN_JUMP_OKX, FLAT_THEN_JUMP_SINA, "throw"));
    const ashare = board.rows.filter((row) => row.market === "ashare");
    expect(ashare.length).toBe(MA_DEVIATION_ASHARE_SYMBOLS.length);
    expect(
      ashare.every(
        (row) =>
          row.lastClose === null && row.w === null && row.wPrev === null && row.wChange === null,
      ),
    ).toBe(true);
    // OKX rows are unaffected.
    expect(board.rows.filter((row) => row.market === "okx" && row.w !== null).length).toBe(
      MA_DEVIATION_SYMBOLS.length + MA_DEVIATION_YAHOO_SYMBOLS.length,
    );
    const ashareGroup = board.groups.find((group) => group.market === "ashare");
    expect(ashareGroup?.meanW).toBeNull();
    expect(ashareGroup?.positiveShare).toBeNull();
    expect(ashareGroup?.count).toBe(0);
    const roundTripped = JSON.parse(JSON.stringify(board)) as typeof board;
    assertNoNaN(roundTripped);
    expect(roundTripped.rows.filter((row) => row.market === "ashare").every((row) => row.lastClose === null)).toBe(true);
  });

  it("falls back to all-null A-share rows when Sina returns HTTP 500", async () => {
    const board = await loadMaDeviationBoard(mockFetch(FLAT_THEN_JUMP_OKX, FLAT_THEN_JUMP_SINA, "http500"));
    expect(board.rows.filter((row) => row.market === "ashare").every((row) => row.w === null)).toBe(true);
    assertNoNaN(JSON.parse(JSON.stringify(board)) as unknown);
  });

  it("requests Sina with datalen=40 and OKX with limit=30, and reuses A-share rows within 30s", async () => {
    const calls: string[] = [];
    const base = mockFetch(FLAT_THEN_JUMP_OKX, FLAT_THEN_JUMP_SINA);
    const countingFetch = ((input: never, init?: never) => {
      calls.push(String(input));
      return base(input, init);
    }) as unknown as typeof fetch;

    const first = await loadMaDeviationBoard(countingFetch);
    const second = await loadMaDeviationBoard(countingFetch);

    const sinaCalls = calls.filter((url) => url.includes("quotes.sina.cn"));
    const okxCalls = calls.filter((url) => url.includes("okx.com"));
    // One Sina request per symbol across BOTH loads: the second load reused
    // the cached A-share rows and called Sina zero times.
    expect(sinaCalls.length).toBe(MA_DEVIATION_ASHARE_SYMBOLS.length);
    expect(sinaCalls.every((url) => url.includes("datalen=40"))).toBe(true);
    // OKX is never cached: fresh on every load.
    expect(okxCalls.length).toBe(MA_DEVIATION_SYMBOLS.length * 2);
    expect(okxCalls.every((url) => url.includes("limit=30"))).toBe(true);
    expect(second.rows).toEqual(first.rows);
  });

  it("refetches A-share rows on the next 30s poll even when Sina takes 1s", async () => {
    // Regression: the cache stamp is taken at fetch start, so a slow Sina
    // fetch cannot push expiry past the next poll and make alternate polls
    // reuse stale rows.
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const base = mockFetch(FLAT_THEN_JUMP_OKX, FLAT_THEN_JUMP_SINA);
      const slowFetch = (async (input: never, init?: never) => {
        calls.push(String(input));
        if (String(input).includes("quotes.sina.cn")) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return base(input, init);
      }) as unknown as typeof fetch;

      const first = loadMaDeviationBoard(slowFetch);
      await vi.advanceTimersByTimeAsync(1000);
      await first;
      const sinaBefore = calls.filter((url) => url.includes("quotes.sina.cn")).length;
      expect(sinaBefore).toBe(MA_DEVIATION_ASHARE_SYMBOLS.length);

      // 29s after the first load finished = 30s after the poll started
      // (setInterval fires on a fixed 30s cadence from poll start).
      await vi.advanceTimersByTimeAsync(29_000);
      const second = loadMaDeviationBoard(slowFetch);
      await vi.advanceTimersByTimeAsync(1000);
      await second;
      const sinaAfter = calls.filter((url) => url.includes("quotes.sina.cn")).length;
      expect(sinaAfter).toBe(sinaBefore + MA_DEVIATION_ASHARE_SYMBOLS.length);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseSinaMinuteJsonp", () => {
  it("parses the JSONP comment + var=(...) payload into ascending bars", () => {
    const bars = parseSinaMinuteJsonp(sinaJsonp([10, 10.5, 11]));
    expect(bars.length).toBe(3);
    expect(bars[0]?.close).toBe(10);
    expect(bars[2]?.close).toBe(11);
    expect(bars[0]?.ts).toBe(Date.UTC(2026, 10, 5, 9, 31, 0) - 8 * 60 * 60_000);
    expect(bars[1]?.ts).toBeGreaterThan(bars[0]?.ts ?? 0);
  });

  it("deduplicates by ts and drops rows with a bad timestamp or close", () => {
    const payload = `var=([{"day":"2026-11-05 09:31:00","close":"10"},{"day":"2026-11-05 09:31:00","close":"10.5"},{"day":"bad","close":"11"},{"day":"2026-11-05 09:32:00","close":"NaN"},{"day":"2026-11-05 09:33:00","close":"11"}])`;
    const bars = parseSinaMinuteJsonp(payload);
    expect(bars.map((bar) => bar.close)).toEqual([10.5, 11]);
  });

  it("throws on a payload without a JSON array", () => {
    expect(() => parseSinaMinuteJsonp("location.href='//sina.com';")).toThrow();
    expect(() => parseSinaMinuteJsonp("var=({not: 'json'})")).toThrow();
  });
});

describe("parseYahooMinuteChart", () => {
  it("parses v8 timestamps + closes into ascending bars, dropping null closes", () => {
    const payload = {
      chart: {
        result: [
          {
            timestamp: [1762400000, 1762400060, 1762400120],
            indicators: { quote: [{ close: [20.5, null, 21.0] }] },
          },
        ],
      },
    };
    const bars = parseYahooMinuteChart(payload);
    expect(bars).toEqual([
      { ts: 1762400000000, close: 20.5 },
      { ts: 1762400120000, close: 21 },
    ]);
  });

  it("throws when the payload has no result", () => {
    expect(() => parseYahooMinuteChart({})).toThrow();
    expect(() => parseYahooMinuteChart({ chart: { result: [] } })).toThrow();
  });
});

describe("computeDeviations", () => {
  it("returns null until 20 closes, then (close - MA20) / MA20 in percent", () => {
    const closes = Array.from({ length: 21 }, (_, i) => 100 + i);
    const devs = computeDeviations(closes);
    expect(devs.slice(0, 19)).toEqual(Array(19).fill(null));
    // MA20 of 101..120 is 110.5; last close 120 -> +8.597%.
    expect(devs[20]).toBeCloseTo(((120 - 110.5) / 110.5) * 100, 6);
  });
});

describe("weightedDeviation", () => {
  it("weights the last 5 deviations 1..5 far to near", () => {
    // Only the last 5 matter; earlier entries are ignored.
    const devs = [99, 99, -5, -3, 0, 2, 4];
    // (1*-5 + 2*-3 + 3*0 + 4*2 + 5*4) / 15 = 17/15.
    expect(weightedDeviation(devs)).toBeCloseTo(17 / 15, 6);
  });

  it("returns null when the last window is incomplete or contains null", () => {
    expect(weightedDeviation([1, 2, 3])).toBeNull();
    expect(weightedDeviation([1, 2, 3, 4, null])).toBeNull();
  });
});

describe("buildRow", () => {
  it("computes W and W_prev from consecutive 5-bar windows", () => {
    // Flat 100 for 25 bars, then a jump to 110: the last window's
    // deviations are positive and rising, the previous window is ~0.
    const bars = [
      ...Array.from({ length: 25 }, (_, i) => ({ ts: i, close: 100 })),
      ...Array.from({ length: 5 }, (_, i) => ({ ts: 25 + i, close: 110 })),
    ];
    const row = buildRow("TEST", "TEST-USDT-SWAP", bars);
    expect(row.market).toBe("okx");
    expect(row.w).not.toBeNull();
    expect(row.wPrev).not.toBeNull();
    expect((row.w as number) - (row.wPrev as number)).toBeGreaterThan(0);
  });

  it("tags A-share rows with market 'ashare'", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ ts: i, close: 10 }));
    const row = buildRow("600487", "sh600487", bars, "ashare");
    expect(row.market).toBe("ashare");
    expect(row.symbol).toBe("600487");
  });
});
