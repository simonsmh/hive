import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateVolumeSpike, isSessionOpenSkipBar } from "../alert-evaluator/core/alerts.ts";
import type { Candle } from "../alert-evaluator/core/types.ts";

/**
 * Offline replay of the production SH000688 sina 5m volume_spike rule.
 * Each bar is evaluated using only confirmed bars at or before it (no lookahead).
 * This is a counterfactual: production evaluates only the latest fresh bar at
 * cron time, and these rules were not live at the 09:30-10:00 ticks.
 */
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/sh000688-sina-5m-2026-11-17-afternoon-to-2026-11-18-morning.json",
);

interface FixtureBar {
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
  symbol: string;
  bars: FixtureBar[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const indexRule = {
  kind: "volume_spike" as const,
  interval: "5m" as const,
  lookback: 20,
  multiple: 2,
  minMovePct: 0.3,
  skipSessionOpenBars: 1,
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

function replay(barShanghai: string) {
  const index = fixture.bars.findIndex((bar) => bar.bar_shanghai === barShanghai);
  if (index < 0) throw new Error(`missing fixture bar ${barShanghai}`);
  const window = fixture.bars.slice(0, index + 1).map(asCandle);
  const last = window[window.length - 1]!;
  const prior = window.slice(window.length - 1 - indexRule.lookback, window.length - 1);
  const avg = prior.reduce((sum, bar) => sum + bar.volume, 0) / prior.length;
  const observed = avg > 0 ? last.volume / avg : null;
  const bodyPct = last.open > 0 ? (Math.abs(last.close - last.open) / last.open) * 100 : 0;
  return {
    bar: barShanghai,
    fired: evaluateVolumeSpike(indexRule, window),
    skippedOpen: isSessionOpenSkipBar(last.ts, "5m", 1),
    observed,
    bodyPct,
    close: last.close,
    volume: last.volume,
  };
}

describe("SH000688 2026-11-18 offline volume_spike replay", () => {
  it("skips the 09:30 open bar that would otherwise clear 2x and 0.3%", () => {
    const row = replay("2026-11-18 09:30");
    expect(row.skippedOpen).toBe(true);
    expect(row.observed).toBeGreaterThan(2);
    expect(row.bodyPct).toBeGreaterThan(0.3);
    expect(row.fired).toBe(false);
  });

  it("would have fired on the 09:35 bar (before the 09:40-10:00 window)", () => {
    const row = replay("2026-11-18 09:35");
    expect(row.skippedOpen).toBe(false);
    expect(row.observed).toBeGreaterThan(2);
    expect(row.bodyPct).toBeGreaterThan(0.3);
    expect(row.fired).toBe(true);
  });

  it("does not fire on any completed 09:40-10:00 bar under the live thresholds", () => {
    const window = ["2026-11-18 09:40", "2026-11-18 09:45", "2026-11-18 09:50", "2026-11-18 09:55", "2026-11-18 10:00"];
    const rows = window.map(replay);
    for (const row of rows) {
      expect(row.skippedOpen, row.bar).toBe(false);
      expect(row.fired, `${row.bar} observed=${row.observed} body=${row.bodyPct}`).toBe(false);
      expect(row.observed, row.bar).toBeLessThan(2);
    }
    // 09:40 body is also below minMovePct; later bars in the window clear 0.3% but not 2x volume.
    expect(rows[0]!.bodyPct).toBeLessThan(0.3);
    expect(rows.slice(1).every((row) => row.bodyPct >= 0.3)).toBe(true);
  });

  it("shows a steady ~2% lift across 09:40-10:00 that the volume screen misses", () => {
    const start = fixture.bars.find((bar) => bar.bar_shanghai === "2026-11-18 09:40")!;
    const end = fixture.bars.find((bar) => bar.bar_shanghai === "2026-11-18 10:00")!;
    const liftPct = ((end.close - start.open) / start.open) * 100;
    expect(liftPct).toBeGreaterThan(2);
    expect(liftPct).toBeLessThan(2.5);
    expect(evaluateVolumeSpike(indexRule, fixture.bars.filter((bar) => bar.ts_ms <= end.ts_ms).map(asCandle))).toBe(
      false,
    );
  });
});
