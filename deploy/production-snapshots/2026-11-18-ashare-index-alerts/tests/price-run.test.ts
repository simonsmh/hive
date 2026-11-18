import { describe, expect, it } from "vitest";
import {
  AlertRuleError,
  evaluatePriceRun,
  isAsharesResumptionBar,
  isCooldownActive,
  isSessionOpenSkipBar,
  measurePriceRun,
  parseRuleParams,
  ruleBarsNeeded,
} from "../alert-evaluator/core/alerts.ts";
import type { Candle } from "../alert-evaluator/core/types.ts";

const FIVE_MIN = 5 * 60_000;
/** 2026-11-18 09:30 Asia/Shanghai */
const OPEN_MS = Date.UTC(2026, 10, 18, 1, 30, 0);
const LUNCH_MS = Date.UTC(2026, 10, 18, 5, 0, 0);

function candle(ts: number, open: number, high: number, low: number, close: number): Candle {
  return { ts, open, high, low, close, volume: 1, volCcy: 0, confirmed: true };
}

/** Four rising 5m bars starting at `startTs`, with a ~1% net lift from the first open. */
function risingRun(startTs: number): Candle[] {
  const opens = [1000, 1002, 1005, 1008];
  const closes = [1002, 1005, 1008, 1010];
  const highs = [1003, 1006, 1009, 1012];
  const lows = [999, 1001, 1004, 1007];
  return opens.map((open, i) => candle(startTs + i * FIVE_MIN, open, highs[i]!, lows[i]!, closes[i]!));
}

const bothRule = {
  kind: "price_run" as const,
  interval: "5m" as const,
  minBars: 4,
  minMovePct: 0.8,
  side: "both" as const,
  skipSessionOpenBars: 1,
  maxBarShare: 0.7,
};

describe("parseRuleParams price_run", () => {
  it("requires interval, minBars, minMovePct and defaults side to both", () => {
    expect(parseRuleParams("price_run", { interval: "5m", minBars: 4, minMovePct: 0.8 })).toEqual({
      kind: "price_run",
      interval: "5m",
      minBars: 4,
      minMovePct: 0.8,
      side: "both",
    });
  });

  it("accepts optional skip and maxBarShare and rejects out-of-range values", () => {
    expect(
      parseRuleParams("price_run", {
        interval: "5m",
        minBars: 4,
        minMovePct: 0.8,
        side: "up",
        skipSessionOpenBars: 1,
        maxBarShare: 0.7,
      }),
    ).toMatchObject({ side: "up", skipSessionOpenBars: 1, maxBarShare: 0.7 });
    expect(() => parseRuleParams("price_run", { interval: "5m", minBars: 2, minMovePct: 0.8 })).toThrow(AlertRuleError);
    expect(() => parseRuleParams("price_run", { interval: "5m", minBars: 4, minMovePct: 0 })).toThrow(AlertRuleError);
    expect(() =>
      parseRuleParams("price_run", { interval: "5m", minBars: 4, minMovePct: 0.8, maxBarShare: 1.1 }),
    ).toThrow(/maxBarShare/);
    expect(() => parseRuleParams("price_run", { interval: "5m", minBars: 4, minMovePct: 0.8, side: "left" })).toThrow(
      /side/,
    );
  });

  it("asks for exactly minBars confirmed candles", () => {
    expect(ruleBarsNeeded(bothRule)).toBe(4);
  });
});

describe("session boundaries", () => {
  it("treats 13:00 as a lunch resumption, not a 09:30 open skip", () => {
    expect(isAsharesResumptionBar(LUNCH_MS, "5m")).toBe(true);
    expect(isAsharesResumptionBar(OPEN_MS, "5m")).toBe(false);
    expect(isSessionOpenSkipBar(LUNCH_MS, "5m", 1)).toBe(false);
    expect(isAsharesResumptionBar(OPEN_MS, "1D")).toBe(false);
  });
});

describe("evaluatePriceRun", () => {
  const start = OPEN_MS + FIVE_MIN; // 09:35, after the open skip

  it("fires on four session-contiguous higher closes with HH/HL and a 0.8% net move", () => {
    const bars = risingRun(start);
    const measured = measurePriceRun(bothRule, bars);
    expect(evaluatePriceRun(bothRule, bars)).toBe(true);
    expect(measured?.side).toBe("up");
    expect(measured?.netMovePct).toBeCloseTo(1.0, 5);
    expect(measured?.startTs).toBe(start);
  });

  it("does not fire on a mid-window pulse or a last-bar pulse that dominates the net move", () => {
    const startTs = start;
    const midPulse = [
      candle(startTs, 1000, 1001, 999, 1000.1),
      candle(startTs + FIVE_MIN, 1000.1, 1020, 1000, 1019),
      candle(startTs + 2 * FIVE_MIN, 1019, 1019.5, 1018, 1019.2),
      candle(startTs + 3 * FIVE_MIN, 1019.2, 1019.8, 1019, 1019.5),
    ];
    // The jump is not the last bar, so the last bar cannot make a new high.
    expect(evaluatePriceRun(bothRule, midPulse)).toBe(false);
    expect(evaluatePriceRun({ ...bothRule, maxBarShare: undefined }, midPulse)).toBe(false);

    const lastPulse = [
      candle(startTs, 1000, 1001, 999, 1000.2),
      candle(startTs + FIVE_MIN, 1000.2, 1001.2, 999.5, 1000.4),
      candle(startTs + 2 * FIVE_MIN, 1000.4, 1001.4, 999.8, 1000.6),
      candle(startTs + 3 * FIVE_MIN, 1000.6, 1014, 1000.2, 1012),
    ];
    // Net ~1.2%, but the last bar is most of the move.
    expect(evaluatePriceRun(bothRule, lastPulse)).toBe(false);
    expect(evaluatePriceRun({ ...bothRule, maxBarShare: undefined }, lastPulse)).toBe(true);
  });

  it("does not fire on oscillation or an incomplete sequence", () => {
    const osc = risingRun(start);
    osc[2] = candle(osc[2]!.ts, 1005, 1006, 999, 1001); // breaks the rise
    expect(evaluatePriceRun(bothRule, osc)).toBe(false);
    expect(evaluatePriceRun(bothRule, risingRun(start).slice(0, 3))).toBe(false);
  });

  it("rejects a window that includes the 09:30 open or a lunch/day gap", () => {
    expect(evaluatePriceRun(bothRule, risingRun(OPEN_MS))).toBe(false);
    const lunch = risingRun(LUNCH_MS); // starts at 13:00
    expect(evaluatePriceRun(bothRule, lunch)).toBe(false);
    const gapped = risingRun(start);
    gapped[2] = { ...gapped[2]!, ts: gapped[2]!.ts + 90 * 60_000 };
    gapped[3] = { ...gapped[3]!, ts: gapped[3]!.ts + 90 * 60_000 };
    expect(evaluatePriceRun(bothRule, gapped)).toBe(false);
  });

  it("honours side=up / side=down independently so one direction cannot suppress the other", () => {
    const upBars = risingRun(start);
    const downBars = [
      candle(start, 1010, 1011, 1006, 1008),
      candle(start + FIVE_MIN, 1008, 1009, 1003, 1005),
      candle(start + 2 * FIVE_MIN, 1005, 1006, 1000, 1002),
      candle(start + 3 * FIVE_MIN, 1002, 1003, 996, 998),
    ];
    const upOnly = { ...bothRule, side: "up" as const };
    const downOnly = { ...bothRule, side: "down" as const };
    expect(evaluatePriceRun(upOnly, upBars)).toBe(true);
    expect(evaluatePriceRun(downOnly, upBars)).toBe(false);
    expect(evaluatePriceRun(downOnly, downBars)).toBe(true);
    expect(evaluatePriceRun(upOnly, downBars)).toBe(false);
    // Existing volume-style cooldown is per rule, so two direction rules stay independent.
    expect(isCooldownActive(start, 1800, start + 5 * 60_000)).toBe(true);
    expect(isCooldownActive(null, 1800, start + 5 * 60_000)).toBe(false);
  });

  it("does not fire when the net move is short of 0.8%", () => {
    const startTs = start;
    const shallow = [
      candle(startTs, 1000, 1002, 999, 1001),
      candle(startTs + FIVE_MIN, 1001, 1003, 1000, 1002),
      candle(startTs + 2 * FIVE_MIN, 1002, 1004, 1001, 1003),
      candle(startTs + 3 * FIVE_MIN, 1003, 1005, 1002, 1004),
    ];
    // net 0.4%
    expect(evaluatePriceRun(bothRule, shallow)).toBe(false);
  });
});
