import { describe, expect, it } from "vitest";
import {
  BREADTH_BIN_COUNT,
  breadthBin,
  buildBreadthPoint,
  buildIndustryEntries,
  computeIndustrySpeed,
  marketsOf,
  parseConstituents,
  parseIndustryCatalog,
  pruneIndustryHistory,
} from "./ths-market.js";

const row = (thscode: string, pct: number | undefined) => ({
  thscode,
  last_price: 10,
  ...(pct === undefined ? {} : { price_change_ratio_pct: pct }),
});

describe("breadthBin", () => {
  it("floors into [k, k+1) and clamps beyond +-10", () => {
    expect(breadthBin(-2.3)).toBe(-3);
    expect(breadthBin(2.7)).toBe(2);
    expect(breadthBin(-10.5)).toBe(-10);
    expect(breadthBin(12.4)).toBe(10);
    expect(breadthBin(null)).toBe(null);
  });
});

describe("marketsOf", () => {
  it("derives exchange and board membership from the thscode", () => {
    const hs300 = new Set(["600519.SH"]);
    expect(marketsOf("600519.SH", hs300)).toEqual(["all", "sh", "hs300"]);
    expect(marketsOf("688256.SH", new Set())).toEqual(["all", "sh", "star"]);
    expect(marketsOf("300750.SZ", new Set())).toEqual(["all", "sz", "gem"]);
    expect(marketsOf("920000.BJ", new Set())).toEqual(["all", "bj"]);
  });
});

describe("buildBreadthPoint", () => {
  it("buckets every row once per market it belongs to", () => {
    const point = buildBreadthPoint(
      [row("600519.SH", 2.7), row("300750.SZ", -2.3), row("688256.SH", 0), row("000001.SZ", undefined)],
      1000,
      new Set(["600519.SH"]),
    );
    expect(point.total).toBe(4);
    expect(point.up).toBe(1);
    expect(point.down).toBe(1);
    expect(point.flat).toBe(1);
    expect(point.unknown).toBe(1);
    expect(point.bins).toHaveLength(BREADTH_BIN_COUNT);
    expect(point.bins[12]).toBe(1); // +2 bin
    expect(point.bins[7]).toBe(1); // -3 bin
    expect(point.markets.gem.total).toBe(1);
    expect(point.markets.star.total).toBe(1);
    expect(point.markets.hs300.total).toBe(1);
    expect(point.markets.all.bins.reduce((sum, count) => sum + count, 0)).toBe(3);
  });
});

describe("industry catalog and entries", () => {
  it("parses catalog rows and joins names onto snapshot rows", () => {
    const catalog = parseIndustryCatalog({
      item: [
        { thscode: "880001.TI", name: "石油化工" },
        { thscode: "880002.TI", name: "券商" },
        { thscode: "not-a-code", name: "坏行" },
      ],
    });
    expect(catalog).toEqual([
      { thscode: "880001.TI", name: "石油化工" },
      { thscode: "880002.TI", name: "券商" },
    ]);
    const entries = buildIndustryEntries(catalog, [
      { thscode: "880001.TI", last_price: 100, price_change_ratio_pct: 2.5 },
      { thscode: "880002.TI", last_price: 200, price_change_ratio_pct: -1.2 },
    ]);
    expect(entries).toEqual([
      { thscode: "880001.TI", name: "石油化工", price: 100, pct: 2.5 },
      { thscode: "880002.TI", name: "券商", price: 200, pct: -1.2 },
    ]);
  });

  it("falls back to the snapshot name, then the code", () => {
    const entries = buildIndustryEntries([], [{ thscode: "880001.TI", last_price: 100, name: "快照名" }]);
    expect(entries[0]?.name).toBe("快照名");
  });
});

describe("computeIndustrySpeed", () => {
  it("uses the point nearest 5 minutes ago and nothing younger", () => {
    const now = 1_000_000;
    const current = new Map([["880001.TI", 102]]);
    expect(computeIndustrySpeed([{ ts: now - 120_000, prices: { "880001.TI": 100 } }], current, now)).toEqual([]);
    const speeds = computeIndustrySpeed(
      [
        { ts: now - 600_000, prices: { "880001.TI": 90 } },
        { ts: now - 300_000, prices: { "880001.TI": 100 } },
      ],
      current,
      now,
    );
    expect(speeds).toEqual([{ thscode: "880001.TI", speedPct: 2, refTs: now - 300_000 }]);
  });

  it("prunes history older than 10 minutes", () => {
    const now = 1_000_000;
    expect(
      pruneIndustryHistory(
        [
          { ts: now - 11 * 60_000, prices: {} },
          { ts: now - 9 * 60_000, prices: {} },
        ],
        now,
      ),
    ).toHaveLength(1);
  });
});

describe("parseConstituents", () => {
  it("extracts plausible constituent codes and drops the rest", () => {
    expect(
      parseConstituents({ item: [{ thscode: "600519.SH" }, { code: "000001.SZ" }, { thscode: "junk" }] }),
    ).toEqual(["600519.SH", "000001.SZ"]);
  });
});
