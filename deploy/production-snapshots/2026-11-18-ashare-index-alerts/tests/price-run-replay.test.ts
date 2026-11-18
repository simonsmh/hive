import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measurePriceRun } from "../alert-evaluator/core/alerts.ts";
import type { Candle } from "../alert-evaluator/core/types.ts";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/ashare-index-sina-5m-2026-11-13-to-2026-11-18.json",
);

interface FixtureBar {
  symbol: string;
  bar_shanghai: string;
  ts_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volCcy: number;
  confirmed: boolean;
}

interface Fixture {
  bars: FixtureBar[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const rule = {
  kind: "price_run" as const,
  interval: "5m" as const,
  minBars: 4,
  minMovePct: 0.8,
  side: "both" as const,
  skipSessionOpenBars: 1,
  maxBarShare: 0.7,
};

function asCandle(bar: FixtureBar): Candle {
  return {
    ts: bar.ts_ms,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    volCcy: bar.volCcy,
    confirmed: bar.confirmed,
  };
}

function replaySymbol(symbol: string) {
  const series = fixture.bars.filter((bar) => bar.symbol === symbol);
  const hits: { bar: string; side: "up" | "down"; netMovePct: number; start: string }[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const prefix = series.slice(0, i + 1).map(asCandle);
    const measured = measurePriceRun(rule, prefix);
    if (!measured) continue;
    hits.push({
      bar: series[i]!.bar_shanghai,
      side: measured.side,
      netMovePct: measured.netMovePct,
      start: series[series.findIndex((bar) => bar.ts_ms === measured.startTs)]!.bar_shanghai,
    });
  }
  return hits;
}

describe("price_run offline replay on available 5m history", () => {
  it("covers three indices over four calendar days, with 13 Nov only a partial afternoon", () => {
    const symbols = [...new Set(fixture.bars.map((bar) => bar.symbol))].sort();
    expect(symbols).toEqual(["SH000300", "SH000688", "SZ399006"]);
    const days = [...new Set(fixture.bars.map((bar) => bar.bar_shanghai.slice(0, 10)))].sort();
    expect(days).toEqual(["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(fixture.bars.filter((bar) => bar.symbol === "SH000300").length).toBe(122);
  });

  it("emits a known set of hits under the frozen thresholds, without lookahead", () => {
    const hits = {
      SH000300: replaySymbol("SH000300"),
      SH000688: replaySymbol("SH000688"),
      SZ399006: replaySymbol("SZ399006"),
    };
    expect(hits.SH000300).toEqual([]);
    expect(hits.SH000688.map((hit) => `${hit.side} ${hit.start} -> ${hit.bar}`)).toEqual([
      "down 2026-11-16 13:20 -> 2026-11-16 13:35",
      "down 2026-11-16 14:05 -> 2026-11-16 14:20",
      "down 2026-11-17 09:45 -> 2026-11-17 10:00",
      "up 2026-11-17 10:45 -> 2026-11-17 11:00",
      "up 2026-11-17 10:50 -> 2026-11-17 11:05",
      "down 2026-11-17 13:35 -> 2026-11-17 13:50",
      "down 2026-11-17 13:45 -> 2026-11-17 14:00",
      "up 2026-11-17 14:35 -> 2026-11-17 14:50",
      "up 2026-11-17 14:40 -> 2026-11-17 14:55",
      "up 2026-11-18 09:40 -> 2026-11-18 09:55",
      "down 2026-11-18 10:00 -> 2026-11-18 10:15",
    ]);
    expect(hits.SZ399006.map((hit) => `${hit.side} ${hit.start} -> ${hit.bar}`)).toEqual([
      "down 2026-11-16 09:35 -> 2026-11-16 09:50",
      "down 2026-11-16 14:05 -> 2026-11-16 14:20",
      "up 2026-11-17 10:50 -> 2026-11-17 11:05",
      "down 2026-11-17 13:35 -> 2026-11-17 13:50",
    ]);
    const total = hits.SH000300.length + hits.SH000688.length + hits.SZ399006.length;
    expect(total).toBe(15);
  });

  it("would first theoretically trigger SH000688 today at the 09:55 bar, not at 09:45", () => {
    const today = replaySymbol("SH000688").filter((hit) => hit.bar.startsWith("2026-11-18"));
    expect(today[0]).toMatchObject({ side: "up", start: "2026-11-18 09:40", bar: "2026-11-18 09:55" });
    // 09:50 window is a four-bar rise but the net move is only ~0.52%, under 0.8%.
    expect(today.some((hit) => hit.bar === "2026-11-18 09:45" || hit.bar === "2026-11-18 09:50")).toBe(false);
  });
});
