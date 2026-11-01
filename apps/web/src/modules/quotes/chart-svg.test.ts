import { describe, expect, it } from "vitest";
import { smaSeries } from "./chart-math";
import {
  buildChartSvg,
  normalizeBars,
  parseMaPeriods,
  summarizeSeries,
} from "./chart-svg";
import type { CandleBar } from "./mapper";

function bar(time: number, open: number, high: number, low: number, close: number): CandleBar {
  return { time, open, high, low, close, volume: 0, confirmed: true };
}

describe("parseMaPeriods", () => {
  it("parses comma-separated periods and dedupes", () => {
    expect(parseMaPeriods("5,10,20,60")).toEqual([5, 10, 20, 60]);
    expect(parseMaPeriods("10,10,5")).toEqual([10, 5]);
    expect(parseMaPeriods(null)).toEqual([]);
    expect(parseMaPeriods("")).toEqual([]);
  });

  it("rejects malformed, zero, oversized, and too many periods", () => {
    expect(() => parseMaPeriods("0")).toThrow();
    expect(() => parseMaPeriods("abc")).toThrow();
    expect(() => parseMaPeriods("5,,10")).toThrow();
    expect(() => parseMaPeriods("501")).toThrow();
    expect(() => parseMaPeriods("1,2,3,4,5,6,7,8,9")).toThrow();
  });
});

describe("normalizeBars", () => {
  it("rescales so the first close is 100", () => {
    const bars = [bar(1, 10, 12, 9, 10), bar(2, 11, 13, 10, 12)];
    const normalized = normalizeBars(bars)!;
    expect(normalized[0]!.close).toBe(100);
    expect(normalized[1]!.close).toBe(120);
    expect(normalized[1]!.high).toBe(130);
  });

  it("returns null when the first close cannot anchor the scale", () => {
    expect(normalizeBars([])).toBeNull();
    expect(normalizeBars([bar(1, 0, 0, 0, 0)])).toBeNull();
    expect(normalizeBars([bar(1, 0, 0, 0, -5)])).toBeNull();
  });

  it("commutes with smaSeries: normalized MA equals MA of normalized bars", () => {
    const bars = [bar(1, 10, 10, 10, 10), bar(2, 20, 20, 20, 20), bar(3, 30, 30, 30, 30)];
    const normalized = normalizeBars(bars)!;
    const maOnNormalized = smaSeries(normalized, 2);
    const normalizedMa = smaSeries(bars, 2).map((v) => (v === null ? null : (v / 10) * 100));
    expect(maOnNormalized).toEqual(normalizedMa);
  });
});

describe("summarizeSeries", () => {
  it("reports first/last closes and change against the first close", () => {
    const bars = [bar(Date.parse("2026-10-28"), 47, 48, 46, 48), bar(Date.parse("2026-10-30"), 42, 45, 42, 42)];
    const summary = summarizeSeries("HTGD", bars, [2]);
    expect(summary.first_close).toBe(48);
    expect(summary.last_close).toBe(42);
    expect(summary.change_pct).toBeCloseTo(-12.5);
    expect(summary.ma_last["2"]).toBe(45);
    expect(summary.count).toBe(2);
  });
});

describe("buildChartSvg", () => {
  it("draws one polyline per series plus dashed MA polylines, with a legend", () => {
    const a = [bar(1, 10, 11, 9, 10), bar(2, 11, 12, 10, 12), bar(3, 12, 13, 11, 11)];
    const b = [bar(1, 100, 101, 99, 100), bar(2, 101, 102, 100, 98), bar(3, 98, 99, 97, 99)];
    const svg = buildChartSvg({
      series: [
        { symbol: "A", bars: a, ma: [{ period: 2, values: smaSeries(a, 2) }] },
        { symbol: "B", bars: b, ma: [] },
      ],
      interval: "1D",
      normalize: false,
    });
    expect(svg.startsWith("<svg")).toBe(true);
    // 2 series lines + 1 MA line (MA has a leading null, so one segment).
    expect(svg.match(/<polyline/g)?.length).toBe(3);
    expect(svg).toContain("A +10.00%");
    expect(svg).toContain("B -1.00%");
    expect(svg).toContain('stroke-dasharray="6 3"');
  });

  it("keeps series on a shared union timeline instead of stretching each one", () => {
    const a = [bar(1, 10, 10, 10, 10), bar(3, 10, 10, 10, 12)];
    const b = [bar(1, 20, 20, 20, 20), bar(2, 20, 20, 20, 22), bar(3, 20, 20, 20, 21)];
    const svg = buildChartSvg({
      series: [
        { symbol: "A", bars: a, ma: [] },
        { symbol: "B", bars: b, ma: [] },
      ],
      interval: "1D",
      normalize: false,
    });
    // Series A skips the middle timestamp: its two points are not adjacent slots.
    const polylines = [...svg.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]!);
    expect(polylines.length).toBe(2);
    const aXs = polylines[0]!.split(" ").map((p) => Number(p.split(",")[0]));
    const bXs = polylines[1]!.split(" ").map((p) => Number(p.split(",")[0]));
    expect(aXs[0]!).toBeCloseTo(bXs[0]!);
    expect(aXs[1]!).toBeCloseTo(bXs[2]!);
    expect(bXs[1]!).toBeGreaterThan(aXs[0]!);
    expect(bXs[1]!).toBeLessThan(aXs[1]!);
  });

  it("returns a placeholder with no polylines when every series is missing", () => {
    const svg = buildChartSvg({ series: [], interval: "1D", normalize: false });
    expect(svg).toContain("No data");
    expect(svg).not.toContain("<polyline");
  });

  it("distinguishes MA periods with different dashes and legend entries", () => {
    const a = [bar(1, 10, 10, 10, 10), bar(2, 20, 20, 20, 20), bar(3, 30, 30, 30, 30)];
    const svg = buildChartSvg({
      series: [
        {
          symbol: "A",
          bars: a,
          ma: [
            { period: 2, values: smaSeries(a, 2) },
            { period: 3, values: smaSeries(a, 3) },
          ],
        },
      ],
      interval: "1D",
      normalize: false,
    });
    expect(svg).toContain("A MA2");
    expect(svg).toContain("A MA3");
    const dashes = [...svg.matchAll(/stroke-dasharray="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(dashes).size).toBeGreaterThan(1);
  });

  it("keeps y labels distinct for tiny low-priced series", () => {
    const a = [bar(1, 0.00001, 0.00001, 0.00001, 0.00001), bar(2, 0.000012, 0.000012, 0.000012, 0.000012)];
    const svg = buildChartSvg({
      series: [{ symbol: "A", bars: a, ma: [] }],
      interval: "1D",
      normalize: false,
    });
    const labels = [...svg.matchAll(/text-anchor="end"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]!);
    expect(labels.length).toBe(5);
    expect(new Set(labels).size).toBe(5);
  });

  it("marks a single-point series with a circle, not an invisible polyline", () => {
    const a = [bar(1, 10, 10, 10, 10)];
    const svg = buildChartSvg({
      series: [{ symbol: "A", bars: a, ma: [{ period: 2, values: smaSeries(a, 2) }] }],
      interval: "1D",
      normalize: false,
    });
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("<polyline");
  });

  it("escapes legend text and labels normalized output", () => {
    const a = [bar(1, 10, 10, 10, 10), bar(2, 10, 10, 10, 20)];
    const svg = buildChartSvg({
      series: [{ symbol: "A&B", bars: a, ma: [] }],
      interval: "1D",
      normalize: true,
    });
    expect(svg).toContain("A&amp;B");
    expect(svg).toContain("normalized, first close = 100");
  });
});
