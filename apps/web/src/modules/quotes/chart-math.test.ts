import { describe, expect, it } from "vitest";
import { applyLivePrice, barChangePct, barIndexAtX, maxVolume, priceRange, smaSeries } from "./chart-math";
import type { CandleBar } from "./mapper";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 0): CandleBar {
  return { time, open, high, low, close, volume, confirmed: true };
}

describe("smaSeries", () => {
  it("is null until the window fills, then averages the closes", () => {
    const bars = [bar(1, 0, 0, 0, 10), bar(2, 0, 0, 0, 20), bar(3, 0, 0, 0, 30), bar(4, 0, 0, 0, 40)];
    expect(smaSeries(bars, 3)).toEqual([null, null, 20, 30]);
  });

  it("handles a period longer than the series and a degenerate period", () => {
    const bars = [bar(1, 0, 0, 0, 10)];
    expect(smaSeries(bars, 5)).toEqual([null]);
    expect(smaSeries(bars, 0)).toEqual([null]);
  });
});

describe("priceRange", () => {
  it("covers bars and overlay values with padding", () => {
    const bars = [bar(1, 10, 12, 9, 11), bar(2, 11, 15, 10, 14)];
    const range = priceRange(bars, [[null, 16]], 0.1);
    expect(range!.min).toBeCloseTo(9 - 0.7);
    expect(range!.max).toBeCloseTo(16 + 0.7);
  });

  it("returns null for no bars and a non-zero span for a flat series", () => {
    expect(priceRange([])).toBeNull();
    const flat = priceRange([bar(1, 5, 5, 5, 5)]);
    expect(flat!.max).toBeGreaterThan(flat!.min);
  });
});

describe("maxVolume and barIndexAtX", () => {
  it("finds the largest volume and clamps indices into range", () => {
    const bars = [bar(1, 1, 1, 1, 1, 7), bar(2, 1, 1, 1, 1, 42), bar(3, 1, 1, 1, 1, 3)];
    expect(maxVolume(bars)).toBe(42);
    expect(maxVolume([])).toBe(0);
    expect(barIndexAtX(0, 300, 3)).toBe(0);
    expect(barIndexAtX(299, 300, 3)).toBe(2);
    expect(barIndexAtX(10_000, 300, 3)).toBe(2);
    expect(barIndexAtX(-5, 300, 3)).toBe(0);
  });
});

describe("barChangePct", () => {
  it("computes the signed change against the open", () => {
    expect(barChangePct(bar(1, 100, 110, 95, 105))).toBeCloseTo(5);
    expect(barChangePct(bar(1, 100, 110, 95, 95))).toBeCloseTo(-5);
    expect(barChangePct(bar(1, 0, 1, 0, 1))).toBeNull();
  });
});

describe("applyLivePrice", () => {
  const bars = [bar(60_000, 100, 105, 99, 102), bar(120_000, 102, 106, 101, 104)];

  it("updates the forming bar's close and extremes", () => {
    const next = applyLivePrice(bars, 108, 150_000, 60_000);
    expect(next).not.toBe(bars);
    expect(next[1]).toMatchObject({ close: 108, high: 108, low: 101 });
    expect(next[0]).toBe(bars[0]);
  });

  it("appends a fresh bar once the price belongs to the next bucket", () => {
    const next = applyLivePrice(bars, 110, 185_000, 60_000);
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ time: 180_000, open: 104, close: 110, confirmed: false });
  });

  it("returns the same reference for stale or invalid prices", () => {
    expect(applyLivePrice(bars, 108, 30_000, 60_000)).toBe(bars);
    expect(applyLivePrice(bars, Number.NaN, 150_000, 60_000)).toBe(bars);
    expect(applyLivePrice([], 108, 150_000, 60_000)).toEqual([]);
  });
});
