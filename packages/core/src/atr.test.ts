import { describe, expect, it } from "vitest";
import {
  AtrInsufficientDataError,
  computeAtr,
  isWeekdayUtc,
  prepareBarsForSymbol,
  trueRange,
  type OhlcBar,
} from "./atr.js";

const DAY_MS = 86_400_000;
// 2026-10-12 is a Monday (UTC).
const MONDAY_MS = Date.UTC(2026, 9, 12);

function bar(dayOffset: number, high: number, low: number, close: number): OhlcBar {
  return { ts: MONDAY_MS + dayOffset * DAY_MS, high, low, close };
}

describe("trueRange", () => {
  it("uses the widest of high-low and the gaps to the previous close", () => {
    expect(trueRange({ ts: 0, high: 10, low: 8, close: 9 }, 9)).toBe(2);
    expect(trueRange({ ts: 0, high: 12, low: 11, close: 11.5 }, 9)).toBe(3);
    expect(trueRange({ ts: 0, high: 8, low: 6, close: 7 }, 10)).toBe(4);
  });
});

describe("computeAtr", () => {
  it("seeds with the simple mean of the first period TRs and applies Wilder smoothing", () => {
    const bars: OhlcBar[] = [
      bar(0, 10, 9, 9.5),
      bar(1, 11, 9, 10), // TR = max(2, |11-9.5|, |9-9.5|) = 2
      bar(2, 12, 10, 11), // TR = max(2, |12-10|, |10-10|) = 2
      bar(3, 13, 11, 12), // TR = max(2, |13-11|, |11-11|) = 2
      bar(4, 15, 12, 14), // TR = max(3, |15-12|, |12-12|) = 3
    ];
    // seed = mean(2,2,2) = 2; then Wilder with period 3: (2*2 + 3)/3 = 7/3
    const result = computeAtr(bars, 3);
    expect(result.atr).toBeCloseTo(7 / 3, 10);
    expect(result.barsUsed).toBe(5);
    expect(result.period).toBe(3);
  });

  it("equals the simple mean when exactly period + 1 bars are supplied", () => {
    const bars = [bar(0, 10, 9, 9.5), bar(1, 11, 9, 10), bar(2, 12, 10, 11)];
    expect(computeAtr(bars, 2).atr).toBeCloseTo(2, 10);
  });

  it("rejects input with fewer than period + 1 bars", () => {
    const bars = [bar(0, 10, 9, 9.5), bar(1, 11, 9, 10)];
    expect(() => computeAtr(bars, 2)).toThrow(AtrInsufficientDataError);
  });

  it("rejects non-positive or non-integer periods", () => {
    const bars = [bar(0, 10, 9, 9.5), bar(1, 11, 9, 10)];
    expect(() => computeAtr(bars, 0)).toThrow(RangeError);
    expect(() => computeAtr(bars, 1.5)).toThrow(RangeError);
  });
});

describe("weekday-only ATR for XAU", () => {
  it("identifies Saturdays and Sundays as non-weekdays", () => {
    expect(isWeekdayUtc(MONDAY_MS)).toBe(true);
    expect(isWeekdayUtc(MONDAY_MS + 5 * DAY_MS)).toBe(false); // Saturday
    expect(isWeekdayUtc(MONDAY_MS + 6 * DAY_MS)).toBe(false); // Sunday
    expect(isWeekdayUtc(MONDAY_MS + 7 * DAY_MS)).toBe(true);
  });

  it("drops weekend bars for XAU but keeps them for other symbols", () => {
    const week = [0, 1, 2, 3, 4, 5, 6].map((d) => bar(d, 10 + d, 9 + d, 9.5 + d));
    expect(prepareBarsForSymbol("XAU", week).map((b) => b.ts)).toEqual(week.slice(0, 5).map((b) => b.ts));
    expect(prepareBarsForSymbol("NVDA", week)).toHaveLength(7);
  });

  it("does not let a weekend gap distort the XAU true range", () => {
    // Friday close 100, Saturday/Sunday bars carry a huge gap that must be ignored.
    const bars = [
      bar(0, 101, 99, 100), // Mon
      bar(1, 102, 99, 101), // Tue
      bar(2, 103, 100, 102), // Wed
      bar(3, 104, 101, 103), // Thu
      bar(4, 105, 102, 104), // Fri
      bar(5, 400, 300, 350), // Sat (should be dropped)
      bar(6, 390, 310, 340), // Sun (should be dropped)
      bar(7, 106, 103, 105), // Mon
    ];
    const weekdayOnly = prepareBarsForSymbol("XAU", bars);
    const withWeekend = computeAtr(bars.slice(0, 5).concat(bars.slice(7)), 3);
    const result = computeAtr(weekdayOnly, 3);
    expect(weekdayOnly).toHaveLength(6);
    expect(result.atr).toBeCloseTo(withWeekend.atr, 10);
    expect(result.atr).toBeLessThan(10);
  });

  it("lowercase symbol input still applies the XAU rule", () => {
    const bars = [0, 1, 5, 6].map((d) => bar(d, 10, 9, 9.5));
    expect(prepareBarsForSymbol("xau", bars)).toHaveLength(2);
  });
});
