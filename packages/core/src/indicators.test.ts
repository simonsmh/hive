import { describe, expect, it } from "vitest";
import { computeAtr, type OhlcBar } from "./atr.js";
import {
  closeLocationValue,
  donchianSeries,
  efficiencyRatioSeries,
  linearRegression,
  maSpread,
  rollingMaxSeries,
  rollingMinSeries,
  rollingRegressionSlope,
  smaSeries,
  trailingMaxPrior,
  trailingMean,
  trueRanges,
  wilderAtrSeries,
  type VolBar,
} from "./indicators.js";

function bar(ts: number, open: number, high: number, low: number, close: number, volume = 100): VolBar {
  return { ts, open, high, low, close, volume };
}

const BARS: VolBar[] = [
  bar(0, 10, 11, 9, 10),
  bar(1, 10, 12, 10, 11),
  bar(2, 11, 13, 10.5, 12),
  bar(3, 12, 12.5, 11, 11.5),
];

describe("trueRanges", () => {
  it("aligns with the bars and uses the previous close from the second bar on", () => {
    // bar0: own range 2. bar1: max(2, |12-10|, |10-10|) = 2. bar2: max(2.5, 2, 0.5) = 2.5. bar3: max(1.5, 0.5, 1) = 1.5.
    expect(trueRanges(BARS)).toEqual([2, 2, 2.5, 1.5]);
  });
});

describe("wilderAtrSeries", () => {
  it("seeds at index len with the mean of the first len true ranges, then smooths", () => {
    // len 2: seed = mean(2, 2.5) = 2.25 at index 2; index 3 = (2.25 + 1.5) / 2 = 1.875.
    expect(wilderAtrSeries(BARS, 2)).toEqual([null, null, 2.25, 1.875]);
  });

  it("agrees with computeAtr on the final value", () => {
    const series = wilderAtrSeries(BARS, 2);
    expect(series[series.length - 1]).toBe(computeAtr(BARS as OhlcBar[], 2).atr);
  });

  it("is all null when there are not enough bars to seed", () => {
    expect(wilderAtrSeries(BARS.slice(0, 2), 2)).toEqual([null, null]);
  });
});

describe("smaSeries", () => {
  it("is null until len values accumulate", () => {
    expect(smaSeries([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
});

describe("maSpread", () => {
  it("is positive while the fast average rides above the slow one in an uptrend", () => {
    // sma2: [_, 1.5, 2.5, 3.5, 4.5]; sma3: [_, _, 2, 3, 4]; spread = sma2 − sma3.
    expect(maSpread([1, 2, 3, 4, 5], 2, 3)).toEqual([null, null, 0.5, 0.5, 0.5]);
  });

  it("is negative in a downtrend and zero for a flat series", () => {
    expect(maSpread([5, 4, 3, 2, 1], 2, 3)).toEqual([null, null, -0.5, -0.5, -0.5]);
    expect(maSpread([3, 3, 3, 3], 2, 3)).toEqual([null, null, 0, 0]);
  });
});

describe("linearRegression", () => {
  it("fits a perfect line exactly, up, down and scaled", () => {
    expect(linearRegression([1, 2, 3, 4])).toEqual({ slope: 1, r2: 1 });
    expect(linearRegression([4, 3, 2, 1])).toEqual({ slope: -1, r2: 1 });
    expect(linearRegression([2, 4, 6, 8])).toEqual({ slope: 2, r2: 1 });
    expect(linearRegression([3, 7])).toEqual({ slope: 4, r2: 1 });
  });

  it("reads slope 0 and r2 0 for a constant series", () => {
    expect(linearRegression([5, 5, 5, 5])).toEqual({ slope: 0, r2: 0 });
  });

  it("fits a noisy rise with a positive slope and an r2 strictly inside (0, 1)", () => {
    // [1, 2, 2, 3]: slope = 3/5 = 0.6; residuals −0.1, 0.3, −0.3, 0.1 → ssRes 0.2, ssTot 2 → r2 = 0.9.
    const fit = linearRegression([1, 2, 2, 3]);
    expect(fit!.slope).toBeCloseTo(0.6, 10);
    expect(fit!.r2).toBeCloseTo(0.9, 10);
    expect(fit!.r2).toBeGreaterThan(0);
    expect(fit!.r2).toBeLessThan(1);
  });

  it("is null when fewer than two values exist", () => {
    expect(linearRegression([])).toBeNull();
    expect(linearRegression([42])).toBeNull();
  });
});

describe("rollingRegressionSlope", () => {
  it("is null until the first full window, then tracks the window fit", () => {
    const two = rollingRegressionSlope([1, 2, 3, 4], 2);
    expect(two.slope).toEqual([null, 1, 1, 1]);
    expect(two.r2).toEqual([null, 1, 1, 1]);
    const three = rollingRegressionSlope([1, 2, 3, 4], 3);
    expect(three.slope).toEqual([null, null, 1, 1]);
    expect(three.r2).toEqual([null, null, 1, 1]);
  });

  it("carries the noisy window's slope and r2 at the final index", () => {
    const { slope, r2 } = rollingRegressionSlope([1, 2, 2, 3], 4);
    expect(slope.slice(0, 3)).toEqual([null, null, null]);
    expect(slope[3]).toBeCloseTo(0.6, 10);
    expect(r2[3]).toBeCloseTo(0.9, 10);
  });

  it("is all null when the window is longer than the series", () => {
    const { slope, r2 } = rollingRegressionSlope([1, 2], 5);
    expect(slope).toEqual([null, null]);
    expect(r2).toEqual([null, null]);
    expect(rollingRegressionSlope([], 3)).toEqual({ slope: [], r2: [] });
  });

  it("rejects a window that cannot hold a line", () => {
    expect(() => rollingRegressionSlope([1, 2, 3], 1)).toThrow(RangeError);
    expect(() => rollingRegressionSlope([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => rollingRegressionSlope([1, 2, 3], 2.5)).toThrow(RangeError);
  });
});

describe("rolling extremes", () => {
  it("look at strictly prior values", () => {
    expect(rollingMaxSeries([3, 1, 4, 2], 2)).toEqual([null, null, 3, 4]);
    expect(rollingMinSeries([3, 1, 4, 2], 2)).toEqual([null, null, 1, 1]);
  });
});

describe("donchianSeries", () => {
  it("channels the prior bars only", () => {
    const { upper, lower } = donchianSeries(BARS, 2);
    expect(upper).toEqual([null, null, 12, 13]);
    expect(lower).toEqual([null, null, 9, 10]);
  });
});

describe("closeLocationValue", () => {
  it("reads 0 at the low, 1 at the high, 0.5 for a zero-range bar", () => {
    expect(closeLocationValue(bar(0, 10, 12, 10, 11.5))).toBe(0.75);
    expect(closeLocationValue(bar(0, 10, 10, 10, 10))).toBe(0.5);
  });
});

describe("efficiencyRatioSeries", () => {
  it("is 1 for a straight path and 0 for pure chop", () => {
    expect(efficiencyRatioSeries([10, 11, 12, 13], 2)).toEqual([null, null, 1, 1]);
    expect(efficiencyRatioSeries([10, 12, 10, 12], 2)[2]).toBe(0);
  });

  it("is 0 when nothing moved at all", () => {
    expect(efficiencyRatioSeries([5, 5, 5], 2)[2]).toBe(0);
  });
});

describe("trailing windows", () => {
  it("trailingMean skips nulls and returns null for an empty window", () => {
    expect(trailingMean([1, null, 3], 3)).toBe(2);
    expect(trailingMean([null, null], 2)).toBeNull();
  });

  it("trailingMaxPrior excludes the last value", () => {
    expect(trailingMaxPrior([1, 5, 3], 2)).toBe(5);
    expect(trailingMaxPrior([7], 3)).toBeNull();
  });
});
