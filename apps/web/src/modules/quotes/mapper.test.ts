import { describe, expect, it } from "vitest";
import {
  buildCandleGeometry,
  buildQuoteBoard,
  resolveSelectedSymbol,
  summarizeLatest,
  toCandleBars,
  type CandleBar,
  type CandleRow,
} from "./mapper";

const bar = (time: number, open: number, high: number, low: number, close: number): CandleBar => ({
  time,
  open,
  high,
  low,
  close,
  confirmed: true,
});

describe("buildQuoteBoard", () => {
  it("keeps the configured symbol order and marks missing quotes with nulls", () => {
    const board = buildQuoteBoard(["NVDA", "BTC", "XAU"], [
      { symbol: "BTC", price: "84512.1", ts: "2026-10-13T12:00:00Z" },
      { symbol: "NVDA", price: 181.5, ts: "2026-10-13T11:59:00Z" },
    ]);
    expect(board).toEqual([
      { symbol: "NVDA", price: 181.5, ts: "2026-10-13T11:59:00Z" },
      { symbol: "BTC", price: 84512.1, ts: "2026-10-13T12:00:00Z" },
      { symbol: "XAU", price: null, ts: null },
    ]);
  });

  it("nulls out a price that is not a finite number", () => {
    expect(buildQuoteBoard(["X"], [{ symbol: "X", price: "n/a", ts: "t" }])[0]?.price).toBeNull();
  });
});

describe("resolveSelectedSymbol", () => {
  it("honours a known symbol and falls back to the first one otherwise", () => {
    expect(resolveSelectedSymbol("BTC", ["NVDA", "BTC"])).toBe("BTC");
    expect(resolveSelectedSymbol("DOGE", ["NVDA", "BTC"])).toBe("NVDA");
    expect(resolveSelectedSymbol(["BTC"], ["NVDA", "BTC"])).toBe("NVDA");
    expect(resolveSelectedSymbol(undefined, [])).toBeNull();
  });
});

describe("toCandleBars", () => {
  it("sorts ascending, parses numeric strings and drops malformed bars", () => {
    const rows: CandleRow[] = [
      { ts: "2026-10-02T00:00:00Z", open: "2", high: "3", low: "1", close: "2.5", confirmed: true },
      { ts: "2026-10-01T00:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5, confirmed: true },
      { ts: "2026-10-03T00:00:00Z", open: 5, high: 4, low: 6, close: 5, confirmed: false },
      { ts: "2026-10-04T00:00:00Z", open: "x", high: 1, low: 1, close: 1, confirmed: true },
      { ts: "not-a-time", open: 1, high: 1, low: 1, close: 1, confirmed: true },
    ];
    const bars = toCandleBars(rows);
    expect(bars.map((b) => b.time)).toEqual([Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2)]);
    expect(bars[1]).toMatchObject({ open: 2, high: 3, low: 1, close: 2.5 });
  });

  it("de-duplicates bars that share a timestamp, keeping the last one", () => {
    const rows: CandleRow[] = [
      { ts: "2026-10-01T00:00:00Z", open: 1, high: 2, low: 1, close: 1, confirmed: false },
      { ts: "2026-10-01T00:00:00Z", open: 1, high: 3, low: 1, close: 2, confirmed: true },
    ];
    expect(toCandleBars(rows)).toEqual([bar(Date.UTC(2026, 9, 1), 1, 3, 1, 2)]);
  });
});

describe("summarizeLatest", () => {
  it("reports the last close and its change against the previous close", () => {
    const summary = summarizeLatest([bar(1, 1, 2, 1, 100), bar(2, 100, 110, 99, 110)]);
    expect(summary).toEqual({ close: 110, time: 2, changePct: 10 });
  });

  it("has no change figure for a single bar, and nothing for no bars", () => {
    expect(summarizeLatest([bar(1, 1, 2, 1, 100)])?.changePct).toBeNull();
    expect(summarizeLatest([])).toBeNull();
  });
});

describe("buildCandleGeometry", () => {
  it("returns null when there is nothing to draw", () => {
    expect(buildCandleGeometry([], 300, 120)).toBeNull();
  });

  it("keeps every high and low inside the padded viewport", () => {
    const bars = [bar(1, 10, 12, 9, 11), bar(2, 11, 15, 10, 14), bar(3, 14, 14, 8, 9)];
    const geometry = buildCandleGeometry(bars, 300, 120, 8);
    expect(geometry).not.toBeNull();
    const ys = geometry!.glyphs.flatMap((g) => [g.wickTop, g.wickBottom]);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(8 - 1e-9);
      expect(y).toBeLessThanOrEqual(120 - 8 + 1e-9);
    }
    expect(geometry!.priceMin).toBe(8);
    expect(geometry!.priceMax).toBe(15);
  });

  it("marks up candles where close >= open and places one glyph per bar, left to right", () => {
    const geometry = buildCandleGeometry([bar(1, 10, 12, 9, 11), bar(2, 11, 11, 8, 9)], 200, 100, 0);
    const [first, second] = geometry!.glyphs;
    expect(first?.up).toBe(true);
    expect(second?.up).toBe(false);
    expect(first!.x).toBeLessThan(second!.x);
  });

  it("gives a flat price series a visible body and a non-zero span", () => {
    const geometry = buildCandleGeometry([bar(1, 5, 5, 5, 5)], 100, 100, 0);
    expect(geometry!.priceMax).toBeGreaterThan(geometry!.priceMin);
    expect(geometry!.glyphs[0]!.bodyHeight).toBeGreaterThanOrEqual(1);
  });
});
