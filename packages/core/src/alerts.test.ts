import { describe, expect, it } from "vitest";
import {
  AlertRuleError,
  alertDedupKey,
  evaluateCandleCloseBreak,
  evaluateLongWick,
  evaluateMaCross,
  evaluatePctMove,
  evaluatePriceCross,
  evaluatePullback,
  evaluateRule,
  evaluateVolumeSpike,
  isCloseConfirmationBar,
  isCooldownActive,
  isFreshBar,
  parseRuleParams,
  percentMove,
  ruleBarsNeeded,
  ruleInterval,
} from "./alerts.js";
import type { Candle } from "./types.js";

function candle(i: number, o: number, h: number, l: number, c: number, volume = 100): Candle {
  return { ts: 1_000_000 * i, open: o, high: h, low: l, close: c, volume, volCcy: 0, confirmed: true };
}

describe("parseRuleParams", () => {
  it("parses a price cross rule", () => {
    expect(parseRuleParams("price_cross", { level: 80, direction: "above" })).toEqual({
      kind: "price_cross",
      level: 80,
      direction: "above",
    });
  });

  it("applies defaults for volume lookback, wick ratio and pullback lookback", () => {
    expect(parseRuleParams("volume_spike", { interval: "5m", multiple: 3 })).toMatchObject({ lookback: 6 });
    expect(parseRuleParams("volume_spike", { interval: "5m", multiple: 2 })).not.toHaveProperty("minMovePct");
    expect(parseRuleParams("volume_spike", { interval: "15m", multiple: 2, lookback: 20, minMovePct: 0.5 })).toMatchObject({ minMovePct: 0.5 });
    expect(() => parseRuleParams("volume_spike", { interval: "5m", multiple: 2, minMovePct: -1 })).toThrow(/minMovePct/);
    expect(parseRuleParams("long_wick", { interval: "1m" })).toMatchObject({ minWickRatio: 0.6, side: "any" });
    expect(parseRuleParams("pullback", { interval: "15m", minDropPct: 2 })).toMatchObject({ lookback: 20 });
  });

  it("applies ma_cross defaults for period, direction and interval", () => {
    expect(parseRuleParams("ma_cross", {})).toEqual({ kind: "ma_cross", period: 5, direction: "above", interval: "5m" });
    expect(parseRuleParams("ma_cross", { period: 10, direction: "below", interval: "15m" })).toEqual({
      kind: "ma_cross",
      period: 10,
      direction: "below",
      interval: "15m",
    });
  });

  it("rejects bad ma_cross periods, directions and intervals", () => {
    expect(() => parseRuleParams("ma_cross", { period: 0 })).toThrow(/period/);
    expect(() => parseRuleParams("ma_cross", { period: 2.5 })).toThrow(/period/);
    expect(() => parseRuleParams("ma_cross", { direction: "sideways" })).toThrow(/direction/);
    expect(() => parseRuleParams("ma_cross", { interval: "2m" })).toThrow(/interval/);
  });

  it("applies retracement defaults for lookback and side", () => {
    expect(parseRuleParams("retracement", { interval: "15m", minRetracePct: 0.3 })).toEqual({
      kind: "retracement",
      interval: "15m",
      lookback: 20,
      minRetracePct: 0.3,
      side: "both",
    });
    expect(parseRuleParams("retracement", { interval: "15m", lookback: 20, minRetracePct: 0.3, side: "top" })).toMatchObject({
      side: "top",
    });
  });

  it("rejects bad retracement intervals, lookbacks, thresholds and sides", () => {
    expect(() => parseRuleParams("retracement", { interval: "2m", minRetracePct: 0.3 })).toThrow(/interval/);
    expect(() => parseRuleParams("retracement", { interval: "15m", lookback: 1, minRetracePct: 0.3 })).toThrow(/lookback/);
    expect(() => parseRuleParams("retracement", { interval: "15m", minRetracePct: 0 })).toThrow(/minRetracePct/);
    expect(() => parseRuleParams("retracement", { interval: "15m", minRetracePct: 0.3, side: "left" })).toThrow(/side/);
  });

  it("rejects unknown kinds, bad intervals, bad directions and non-finite levels", () => {
    expect(() => parseRuleParams("moon", {})).toThrow(AlertRuleError);
    expect(() => parseRuleParams("candle_close_break", { interval: "2m", level: 1, direction: "above" })).toThrow(
      /interval/,
    );
    expect(() => parseRuleParams("price_cross", { level: 1, direction: "up" })).toThrow(/direction/);
    expect(() => parseRuleParams("price_cross", { level: "1", direction: "above" })).toThrow(/finite number/);
    expect(() => parseRuleParams("price_cross", null)).toThrow(/must be an object/);
    expect(() => parseRuleParams("volume_spike", { interval: "5m", multiple: 2, lookback: 0 })).toThrow(/lookback/);
    expect(() => parseRuleParams("long_wick", { interval: "1m", minWickRatio: 1 })).toThrow(/minWickRatio/);
  });
});

describe("evaluatePriceCross", () => {
  const above = { kind: "price_cross" as const, level: 100, direction: "above" as const };
  const below = { kind: "price_cross" as const, level: 100, direction: "below" as const };

  it("fires only on the crossing tick", () => {
    expect(evaluatePriceCross(above, 99, 101)).toBe(true);
    expect(evaluatePriceCross(above, 101, 102)).toBe(false);
    expect(evaluatePriceCross(below, 101, 99)).toBe(true);
    expect(evaluatePriceCross(below, 99, 98)).toBe(false);
  });

  it("does not fire without a previous price", () => {
    expect(evaluatePriceCross(above, null, 150)).toBe(false);
  });
});

describe("evaluateCandleCloseBreak", () => {
  it("compares the last confirmed close against the level", () => {
    const params = { kind: "candle_close_break" as const, interval: "5m" as const, level: 100, direction: "above" as const };
    expect(evaluateCandleCloseBreak(params, [candle(1, 99, 101, 98, 101)])).toBe(true);
    expect(evaluateCandleCloseBreak(params, [candle(1, 99, 102, 98, 100)])).toBe(false);
    expect(evaluateCandleCloseBreak({ ...params, direction: "below" }, [candle(1, 99, 101, 98, 99)])).toBe(true);
    expect(evaluateCandleCloseBreak(params, [])).toBe(false);
  });
});

describe("evaluateVolumeSpike", () => {
  const params = { kind: "volume_spike" as const, interval: "5m" as const, multiple: 3, lookback: 6 };

  it("fires when the latest volume is >= multiple x average of the prior 6 bars", () => {
    const history = [1, 2, 3, 4, 5, 6].map((i) => candle(i, 10, 11, 9, 10, 100));
    expect(evaluateVolumeSpike(params, [...history, candle(7, 10, 11, 9, 10, 300)])).toBe(true);
    expect(evaluateVolumeSpike(params, [...history, candle(7, 10, 11, 9, 10, 299)])).toBe(false);
  });

  it("uses exactly the 6 bars before the latest bar", () => {
    const old = [0, 1, 2].map((i) => candle(i, 10, 11, 9, 10, 10_000));
    const recent = [3, 4, 5, 6, 7, 8].map((i) => candle(i, 10, 11, 9, 10, 100));
    expect(evaluateVolumeSpike(params, [...old, ...recent, candle(9, 10, 11, 9, 10, 300)])).toBe(true);
  });

  it("needs lookback + 1 bars", () => {
    const history = [1, 2, 3, 4, 5].map((i) => candle(i, 10, 11, 9, 10, 100));
    expect(evaluateVolumeSpike(params, history)).toBe(false);
  });

  it("with minMovePct, also requires the latest bar's own move to reach it", () => {
    const history = [1, 2, 3, 4, 5, 6].map((i) => candle(i, 100, 101, 99, 100, 100));
    const moveParams = { kind: "volume_spike" as const, interval: "5m" as const, multiple: 3, lookback: 6, minMovePct: 0.5 };
    expect(evaluateVolumeSpike(moveParams, [...history, candle(7, 100, 101, 99, 100.6, 300)])).toBe(true);
    expect(evaluateVolumeSpike(moveParams, [...history, candle(7, 100, 101, 99, 100.4, 300)])).toBe(false);
    expect(evaluateVolumeSpike(moveParams, [...history, candle(7, 100, 101, 99, 100.6, 299)])).toBe(false);
  });
});

describe("evaluateLongWick", () => {
  it("detects an upper wick at or above the ratio of the bar range", () => {
    const params = { kind: "long_wick" as const, interval: "1m" as const, minWickRatio: 0.6, side: "upper" as const };
    // range 10, body 9..10, upper wick 5 -> 0.5 (not enough)
    expect(evaluateLongWick(params, [candle(1, 9, 15, 5, 10)])).toBe(false);
    // range 10, body 9..10, upper wick 7 -> 0.7
    expect(evaluateLongWick(params, [candle(1, 9, 17, 7, 10)])).toBe(true);
  });

  it("honours the side filter", () => {
    const lowerOnly = { kind: "long_wick" as const, interval: "1m" as const, minWickRatio: 0.6, side: "lower" as const };
    // long upper wick only
    expect(evaluateLongWick(lowerOnly, [candle(1, 9, 17, 7, 10)])).toBe(false);
    expect(evaluateLongWick({ ...lowerOnly, side: "any" }, [candle(1, 9, 17, 7, 10)])).toBe(true);
  });

  it("never fires on a zero-range bar", () => {
    const params = { kind: "long_wick" as const, interval: "1m" as const, minWickRatio: 0.6, side: "any" as const };
    expect(evaluateLongWick(params, [candle(1, 10, 10, 10, 10)])).toBe(false);
  });
});

describe("evaluatePullback", () => {
  const params = { kind: "pullback" as const, interval: "15m" as const, lookback: 3, minDropPct: 5 };

  it("fires when the last close is >= minDropPct below the window high", () => {
    const window = [candle(1, 100, 110, 99, 105), candle(2, 105, 112, 104, 108), candle(3, 108, 109, 100, 100)];
    // peak 112, last close 100 -> drop 10.7%
    expect(evaluatePullback(params, window)).toBe(true);
    const shallow = [candle(1, 100, 110, 99, 105), candle(2, 105, 112, 104, 108), candle(3, 108, 111, 106, 107)];
    // peak 112, last close 107 -> drop 4.46%
    expect(evaluatePullback(params, shallow)).toBe(false);
  });

  it("requires a full lookback window", () => {
    expect(evaluatePullback(params, [candle(1, 100, 110, 99, 100)])).toBe(false);
  });
});

function closes(...values: number[]): Candle[] {
  return values.map((close, i) => candle(i + 1, close, close, close, close));
}

describe("pct_move", () => {
  it("parses interval, lookback and minAbsPct without defaults", () => {
    expect(parseRuleParams("pct_move", { interval: "1m", lookback: 10, minAbsPct: 1 })).toEqual({
      kind: "pct_move",
      interval: "1m",
      lookback: 10,
      minAbsPct: 1,
    });
    expect(() => parseRuleParams("pct_move", { interval: "1m", minAbsPct: 1 })).toThrow(/lookback/);
    expect(() => parseRuleParams("pct_move", { interval: "1m", lookback: 10 })).toThrow(/minAbsPct/);
  });

  it("bounds lookback to integers from 1 to 500", () => {
    const base = { interval: "1m", minAbsPct: 1 };
    expect(parseRuleParams("pct_move", { ...base, lookback: 1 })).toMatchObject({ lookback: 1 });
    expect(parseRuleParams("pct_move", { ...base, lookback: 500 })).toMatchObject({ lookback: 500 });
    expect(() => parseRuleParams("pct_move", { ...base, lookback: 0 })).toThrow(/lookback/);
    expect(() => parseRuleParams("pct_move", { ...base, lookback: 501 })).toThrow(/lookback/);
    expect(() => parseRuleParams("pct_move", { ...base, lookback: 2.5 })).toThrow(/lookback/);
    expect(() => parseRuleParams("pct_move", { ...base, lookback: "10" })).toThrow(/lookback/);
  });

  it("requires a positive finite minAbsPct and a known interval", () => {
    const base = { interval: "1m", lookback: 10 };
    expect(() => parseRuleParams("pct_move", { ...base, minAbsPct: 0 })).toThrow(/greater than 0/);
    expect(() => parseRuleParams("pct_move", { ...base, minAbsPct: -1 })).toThrow(/greater than 0/);
    expect(() => parseRuleParams("pct_move", { ...base, minAbsPct: "1" })).toThrow(/finite number/);
    expect(() => parseRuleParams("pct_move", { ...base, minAbsPct: 1, interval: "2m" })).toThrow(/interval/);
  });

  it("computes the signed move of the latest close against the close lookback bars earlier", () => {
    expect(percentMove(3, closes(100, 101, 102, 103))).toEqual({ earlier: 100, last: 103, pct: 3 });
    expect(percentMove(1, closes(100, 98))).toEqual({ earlier: 100, last: 98, pct: -2 });
  });

  it("returns null when bars are missing or the earlier close is not positive", () => {
    expect(percentMove(3, closes(100, 101, 102))).toBeNull();
    expect(percentMove(1, [])).toBeNull();
    expect(percentMove(1, closes(0, 5))).toBeNull();
    expect(percentMove(1, closes(-1, 5))).toBeNull();
  });

  it("fires at exactly the threshold, in either direction", () => {
    const params = { kind: "pct_move" as const, interval: "1m" as const, lookback: 1, minAbsPct: 1 };
    expect(evaluatePctMove(params, closes(200, 202))).toBe(true);
    expect(evaluatePctMove(params, closes(200, 198))).toBe(true);
    expect(evaluatePctMove(params, closes(200, 201.9))).toBe(false);
    expect(evaluatePctMove(params, closes(200, 200))).toBe(false);
  });

  it("does not fire when the window is missing bars", () => {
    const params = { kind: "pct_move" as const, interval: "1m" as const, lookback: 10, minAbsPct: 1 };
    expect(evaluatePctMove(params, closes(100, 110, 120))).toBe(false);
    expect(evaluatePctMove(params, [])).toBe(false);
  });

  it("compares against the bar exactly lookback positions before the latest one", () => {
    const params = { kind: "pct_move" as const, interval: "1m" as const, lookback: 1, minAbsPct: 1 };
    // Bar two positions back (110) would show a large move; the bar one position back (101) shows none.
    expect(evaluatePctMove(params, closes(100, 110, 101, 101))).toBe(false);
  });
});

describe("evaluateRule", () => {
  it("returns the bar timestamp and rounded payload values when pct_move fires", () => {
    const params = { kind: "pct_move" as const, interval: "1m" as const, lookback: 2, minAbsPct: 1 };
    const bars = [candle(1, 100, 100, 100, 100), candle(2, 100, 100, 100, 100), candle(3, 100, 100, 100, 101.2345678)];
    expect(evaluateRule(params, bars)).toEqual({
      barTs: 3_000_000,
      details: { last_price: 101.2345678, earlier_price: 100, pct: 1.2346, lookback: 2, min_abs_pct: 1 },
    });
  });

  it("returns null when pct_move does not fire", () => {
    const params = { kind: "pct_move" as const, interval: "1m" as const, lookback: 2, minAbsPct: 5 };
    expect(evaluateRule(params, closes(100, 100, 101))).toBeNull();
  });

  it("compares the two latest closes for price_cross, which reads 1m bars", () => {
    const params = { kind: "price_cross" as const, level: 100, direction: "above" as const };
    const fired = evaluateRule(params, closes(99, 101));
    expect(fired).toEqual({ barTs: 2_000_000, details: { last_price: 101, previous_price: 99, level: 100 } });
    expect(evaluateRule(params, closes(101))).toBeNull();
    expect(evaluateRule(params, closes(99, 98))).toBeNull();
  });

  it("delegates the other kinds to their evaluators", () => {
    const breakout = { kind: "candle_close_break" as const, interval: "5m" as const, level: 100, direction: "above" as const };
    expect(evaluateRule(breakout, closes(101))).toMatchObject({ barTs: 1_000_000, details: { last_price: 101, level: 100 } });
    expect(evaluateRule(breakout, closes(99))).toBeNull();

    const spike = { kind: "volume_spike" as const, interval: "5m" as const, multiple: 3, lookback: 2 };
    const quiet = [candle(1, 10, 11, 9, 10, 100), candle(2, 10, 11, 9, 10, 100), candle(3, 10, 11, 9, 10, 400)];
    // 400 / mean(100, 100) = 4 measured; 3 is only the rule threshold. Both are recorded, never conflated.
    expect(evaluateRule(spike, quiet)).toMatchObject({
      details: { last_volume: 400, multiple: 3, lookback: 2, observed_multiple: 4 },
    });
    expect(evaluateRule(spike, quiet.slice(1))).toBeNull();

    const wick = { kind: "long_wick" as const, interval: "1m" as const, minWickRatio: 0.6, side: "upper" as const };
    expect(evaluateRule(wick, [candle(1, 9, 17, 7, 10)])).toMatchObject({ details: { last_price: 10 } });
    expect(evaluateRule(wick, [candle(1, 9, 11, 9, 10)])).toBeNull();

    const pullback = { kind: "pullback" as const, interval: "15m" as const, lookback: 3, minDropPct: 5 };
    const drop = [candle(1, 100, 110, 99, 105), candle(2, 105, 112, 104, 108), candle(3, 108, 109, 100, 100)];
    expect(evaluateRule(pullback, drop)).toMatchObject({ details: { last_price: 100, min_drop_pct: 5 } });
    expect(evaluateRule(pullback, drop.slice(0, 2))).toBeNull();
  });

  it("returns null without bars", () => {
    const params = { kind: "price_cross" as const, level: 100, direction: "above" as const };
    expect(evaluateRule(params, [])).toBeNull();
  });
});

describe("evaluateMaCross", () => {
  // Daily closes average to exactly 100, so the cross level is unambiguous.
  const daily = closes(100, 100, 100, 100, 100);
  const params = { kind: "ma_cross" as const, period: 5, direction: "above" as const, interval: "5m" as const };

  it("fires when the latest bar closes across the daily average, with the average in the payload", () => {
    expect(evaluateRule(params, closes(99, 101), daily)).toEqual({
      barTs: 2_000_000,
      details: { ma: 100, last_price: 101, previous_price: 99, period: 5, close_confirmation: 0 },
    });
  });

  it("treats a previous close exactly on the average as still below it", () => {
    expect(evaluateRule(params, closes(100, 101), daily)).not.toBeNull();
  });

  it("does not fire when the previous bar is already above, or the latest bar stays below", () => {
    expect(evaluateRule(params, closes(101, 102), daily)).toBeNull();
    expect(evaluateRule(params, closes(99, 100), daily)).toBeNull();
  });

  it("mirrors the cross for direction below", () => {
    const below = { ...params, direction: "below" as const };
    expect(evaluateRule(below, closes(101, 99), daily)).not.toBeNull();
    expect(evaluateRule(below, closes(99, 98), daily)).toBeNull();
  });

  it("averages only the last period daily closes", () => {
    // Six closes: the oldest (50) must not drag the average below 100.
    const six = closes(50, 100, 100, 100, 100, 100);
    expect(evaluateRule(params, closes(99, 101), six)).toMatchObject({ details: { ma: 100 } });
  });

  it("needs two intraday bars and a full period of daily closes", () => {
    expect(evaluateRule(params, closes(101), daily)).toBeNull();
    expect(evaluateRule(params, closes(99, 101), daily.slice(1))).toBeNull();
    expect(evaluateRule(params, closes(99, 101))).toBeNull();
  });

  it("marks the 14:55 Shanghai bar as the close confirmation and earlier bars as provisional", () => {
    const closeBar: Candle = {
      ts: Date.parse("2026-11-02T06:55:00.000Z"),
      open: 101,
      high: 101,
      low: 101,
      close: 101,
      volume: 100,
      volCcy: 0,
      confirmed: true,
    };
    const morningBar: Candle = {
      ...closeBar,
      ts: Date.parse("2026-11-02T02:00:00.000Z"),
      close: 99,
    };
    expect(isCloseConfirmationBar(closeBar.ts)).toBe(true);
    expect(isCloseConfirmationBar(morningBar.ts)).toBe(false);
    const fired = evaluateMaCross(params, [morningBar, closeBar], daily);
    expect(fired).toMatchObject({ details: { close_confirmation: 1 } });
    const provisionalPrev: Candle = { ...closeBar, ts: Date.parse("2026-11-02T01:55:00.000Z"), close: 99 };
    const provisionalBar: Candle = { ...closeBar, ts: Date.parse("2026-11-02T02:00:00.000Z"), close: 101 };
    expect(evaluateMaCross(params, [provisionalPrev, provisionalBar], daily)).toMatchObject({
      details: { close_confirmation: 0 },
    });
  });

  it("recalculates the average with today's close on the confirmation bar (2026-11-05 HTGD case)", () => {
    // Real daily closes: 10-29 44.60, 10-30 42.42, 11-02 43.52, 11-03 40.45, 11-04 43.52.
    // The 14:55 bar closes 43.71, so the confirmation average is
    // (42.42 + 43.52 + 40.45 + 43.52 + 43.71) / 5 = 42.724, not the 42.902 through yesterday.
    const dailyCloses: Candle[] = [
      ["2026-10-29", 44.6],
      ["2026-10-30", 42.42],
      ["2026-11-02", 43.52],
      ["2026-11-03", 40.45],
      ["2026-11-04", 43.52],
    ].map(([date, close]) => ({
      ts: Date.parse(`${date}T00:00:00.000Z`),
      open: close as number,
      high: close as number,
      low: close as number,
      close: close as number,
      volume: 0,
      volCcy: 0,
      confirmed: true,
    }));
    const prev: Candle = {
      ts: Date.parse("2026-11-05T06:50:00.000Z"),
      open: 42.6,
      high: 42.6,
      low: 42.6,
      close: 42.6,
      volume: 100,
      volCcy: 0,
      confirmed: true,
    };
    const closeBar: Candle = { ...prev, ts: Date.parse("2026-11-05T06:55:00.000Z"), close: 43.71 };
    expect(evaluateMaCross(params, [prev, closeBar], dailyCloses)).toEqual({
      barTs: closeBar.ts,
      details: { ma: 42.724, last_price: 43.71, previous_price: 42.6, period: 5, close_confirmation: 1 },
    });
  });

  it("gives the same confirmation average when today's daily bar is already written", () => {
    // Same closes as above, plus the 11-05 daily bar (43.71) already in the series: the prior window
    // must exclude it, so the average is still 42.724 and does not double-count today.
    const dailyCloses: Candle[] = [
      ["2026-10-29", 44.6],
      ["2026-10-30", 42.42],
      ["2026-11-02", 43.52],
      ["2026-11-03", 40.45],
      ["2026-11-04", 43.52],
      ["2026-11-05", 43.71],
    ].map(([date, close]) => ({
      ts: Date.parse(`${date}T00:00:00.000Z`),
      open: close as number,
      high: close as number,
      low: close as number,
      close: close as number,
      volume: 0,
      volCcy: 0,
      confirmed: true,
    }));
    const prev: Candle = {
      ts: Date.parse("2026-11-05T06:50:00.000Z"),
      open: 42.6,
      high: 42.6,
      low: 42.6,
      close: 42.6,
      volume: 100,
      volCcy: 0,
      confirmed: true,
    };
    const closeBar: Candle = { ...prev, ts: Date.parse("2026-11-05T06:55:00.000Z"), close: 43.71 };
    expect(evaluateMaCross(params, [prev, closeBar], dailyCloses)).toMatchObject({
      details: { ma: 42.724, close_confirmation: 1 },
    });
  });

  it("keeps the provisional average through yesterday (real 2026-11-05 09:41 alert)", () => {
    // Same daily closes as above; the 09:35/09:40 bars cross the average through 11-04 (42.902).
    const dailyCloses: Candle[] = [
      ["2026-10-29", 44.6],
      ["2026-10-30", 42.42],
      ["2026-11-02", 43.52],
      ["2026-11-03", 40.45],
      ["2026-11-04", 43.52],
    ].map(([date, close]) => ({
      ts: Date.parse(`${date}T00:00:00.000Z`),
      open: close as number,
      high: close as number,
      low: close as number,
      close: close as number,
      volume: 0,
      volCcy: 0,
      confirmed: true,
    }));
    const prev: Candle = {
      ts: Date.parse("2026-11-05T01:35:00.000Z"),
      open: 42.69,
      high: 42.69,
      low: 42.69,
      close: 42.69,
      volume: 100,
      volCcy: 0,
      confirmed: true,
    };
    const last: Candle = { ...prev, ts: Date.parse("2026-11-05T01:40:00.000Z"), close: 43.38 };
    expect(evaluateMaCross(params, [prev, last], dailyCloses)).toEqual({
      barTs: last.ts,
      details: { ma: 42.902, last_price: 43.38, previous_price: 42.69, period: 5, close_confirmation: 0 },
    });
  });

  it("needs period - 1 prior daily closes for the confirmation bar", () => {
    const shortDaily: Candle[] = [
      ["2026-11-02", 43.52],
      ["2026-11-03", 40.45],
      ["2026-11-04", 43.52],
    ].map(([date, close]) => ({
      ts: Date.parse(`${date}T00:00:00.000Z`),
      open: close as number,
      high: close as number,
      low: close as number,
      close: close as number,
      volume: 0,
      volCcy: 0,
      confirmed: true,
    }));
    const prev: Candle = {
      ts: Date.parse("2026-11-05T06:50:00.000Z"),
      open: 42.6,
      high: 42.6,
      low: 42.6,
      close: 42.6,
      volume: 100,
      volCcy: 0,
      confirmed: true,
    };
    const closeBar: Candle = { ...prev, ts: Date.parse("2026-11-05T06:55:00.000Z"), close: 43.71 };
    expect(evaluateMaCross(params, [prev, closeBar], shortDaily)).toBeNull();
  });
});

describe("evaluateRetracement", () => {
  // candle(ts_index, open, high, low, close); rows are short enough to read one line each.
  const bar = candle;
  const params = {
    kind: "retracement" as const,
    interval: "15m" as const,
    lookback: 4,
    minRetracePct: 0.3,
    side: "both" as const,
  };
  // Bars 1..5 sit in 20..44 and never reach the anchor window. Bars 6..9 hold exactly high 60 and low 57.5;
  // the judged bar is 10, so those four are its anchor window.
  const base = [
    bar(1, 30, 40, 20, 30),
    bar(2, 30, 41, 20, 30),
    bar(3, 30, 42, 20, 30),
    bar(4, 30, 43, 20, 30),
    bar(5, 30, 44, 20, 30),
    bar(6, 59, 60, 57.5, 59),
    bar(7, 59, 60, 57.5, 59),
    bar(8, 59, 60, 57.5, 59),
    bar(9, 59, 60, 57.5, 59),
  ];

  // A leg fires on its first bar only, so a firing test needs the previous bar to sit inside the 0.3% band
  // for the tested side (edge-triggered). neutralPrev keeps bar 9's high/low, so the judged bar's anchors
  // stay 60 / 57.5 while its close is chosen to be neutral.
  const neutralPrev = (close: number) => bar(9, close, 60, 57.5, close);
  const withNeutralPrev = (prevClose: number, judged: ReturnType<typeof bar>) => [
    ...base.slice(0, 8),
    neutralPrev(prevClose),
    judged,
  ];

  it("reports a suspected top when the close gives back the threshold from the window high", () => {
    // (60 - 56.5) / 60 = 5.8333% off the high, larger than the 1.7391% the 56.5 close sits above the 57.5 low;
    // the bar's own 56.5 low cannot lower that anchor because the anchor window stops at bar 9. The previous
    // bar's 59.9 close is only 0.1667% off the high, so this is the leg's first bar, not a continuation.
    expect(
      evaluateRule({ ...params, side: "top" }, withNeutralPrev(59.9, bar(10, 56.5, 60, 56.5, 56.5))),
    ).toEqual({
      barTs: 10_000_000,
      details: {
        is_top: 1,
        last_price: 56.5,
        anchor_price: 60,
        retrace_pct: 5.8333,
        lookback: 4,
        min_retrace_pct: 0.3,
      },
    });
  });

  it("reports a suspected bottom when the close rebounds the threshold off the window low", () => {
    // A close 0.9565% above the 57.5 low is always further from that low than 0.3%, so with "both" the top side
    // (here 3.25% off the 60 high) usually wins. A bottom rule says which anchor matters, and the deviation is
    // measured from the window low rather than the bar's own 57.9 low. The previous bar's 57.6 close is only
    // 0.1739% above the low, so this is the leg's first bar.
    const bottomOnly = { ...params, side: "bottom" as const };
    expect(
      evaluateRule(bottomOnly, withNeutralPrev(57.6, bar(10, 58, 58.1, 57.9, 58.05))),
    ).toEqual({
      barTs: 10_000_000,
      details: {
        is_top: 0,
        last_price: 58.05,
        anchor_price: 57.5,
        retrace_pct: 0.9565,
        lookback: 4,
        min_retrace_pct: 0.3,
      },
    });
  });

  it("does not re-fire while the same leg persists on the next bar", () => {
    // The original bar 9 close 59 is already 1.6667% off the 60 high, so bar 10's 5.8333% retracement is the
    // same leg continuing, not a new turning: the 30-minute metronome this rule used to produce.
    expect(evaluateRule({ ...params, side: "top" }, [...base, bar(10, 56.5, 60, 56.5, 56.5)])).toBeNull();
  });

  it("fires again when the leg flips sides", () => {
    // Previous bar 59.9 sits in the bottom state (4.1739% above the low) but inside the top band (0.1667% off
    // the high); the judged bar's 5.8333% top retracement is a new leg, not a continuation of the bottom one.
    expect(evaluateRule(params, withNeutralPrev(59.9, bar(10, 56.5, 60, 56.5, 56.5)))).toMatchObject({
      details: { is_top: 1, anchor_price: 60, retrace_pct: 5.8333 },
    });
  });

  it("does not fire while the move from the anchor is below the threshold", () => {
    // A top rule: 0.05% back from the 60 high, short of the 0.3% threshold.
    expect(evaluateRule({ ...params, side: "top" }, [...base, bar(10, 57.66, 59.97, 57.65, 59.97)])).toBeNull();
    // A bottom rule: 0.2609% up from the 57.5 low, also short.
    expect(evaluateRule({ ...params, side: "bottom" }, [...base, bar(10, 57.66, 59.97, 57.65, 57.66)])).toBeNull();
  });

  it("moves the anchor with a new high instead of firing inside the window high", () => {
    // A bar that closes on its own high cannot have retraced from it (0%), and 58.5 is 2.5% below the 60 the
    // window still holds, so a top rule does not fire on the new-high bar either: it fires from the bar after it,
    // which is judged against the new 61 high and stays inside 1% of it.
    const top = { ...params, side: "top" as const };
    const newHigh = [...base, bar(10, 58.5, 61, 58.5, 61)];
    expect(evaluateRule(top, newHigh)).toBeNull();
    expect(evaluateRule(top, [...newHigh, bar(11, 60.9, 61.2, 60.85, 60.9)])).toBeNull();
    // The old 60 is out of the window by then, so a deeper pullback off 61 does fire and reports the new anchor.
    expect(evaluateRule(top, [...newHigh, bar(11, 60.9, 61.2, 60.5, 60.5)])).toMatchObject({
      details: { anchor_price: 61, retrace_pct: 0.8197 },
    });
  });

  it("honours the side, so a top-only rule ignores the rebound off the low", () => {
    const rebounded = withNeutralPrev(57.6, bar(10, 58, 58.1, 57.9, 58.05));
    expect(evaluateRule({ ...params, side: "bottom" }, rebounded)).toMatchObject({ details: { is_top: 0 } });
    expect(evaluateRule({ ...params, side: "top" }, [...base, bar(10, 59.85, 59.9, 57.6, 59.85)])).toBeNull();
    const retraced = [...base, bar(10, 56.5, 60, 56.5, 56.5)];
    expect(evaluateRule({ ...params, side: "bottom" }, retraced)).toBeNull();
    expect(
      evaluateRule({ ...params, side: "top" }, withNeutralPrev(59.9, bar(10, 56.5, 60, 56.5, 56.5))),
    ).toMatchObject({ details: { is_top: 1 } });
  });

  it("reports the larger deviation when a wide bar retraces from both anchors", () => {
    // Narrow window (high 60, low 59.9) so the previous bar's 59.95 close sits inside the band on both sides
    // (0.0833% each) and the judged bar is the leg's first: range 50..60 with close 52 gives 13.3333% off
    // the 60 top, 4% off the 50 low.
    const narrow = [
      bar(1, 30, 40, 20, 30),
      bar(2, 30, 41, 20, 30),
      bar(3, 30, 42, 20, 30),
      bar(4, 30, 43, 20, 30),
      bar(5, 30, 44, 20, 30),
      bar(6, 59.95, 60, 59.9, 59.95),
      bar(7, 59.95, 60, 59.9, 59.95),
      bar(8, 59.95, 60, 59.9, 59.95),
      bar(9, 59.95, 60, 59.9, 59.95),
    ];
    expect(evaluateRule(params, [...narrow, bar(10, 60, 60, 50, 52)])).toMatchObject({
      details: { is_top: 1, anchor_price: 60, retrace_pct: 13.3333 },
    });
    // The low of a wide bar is always closer in percentage terms than its high, so the bottom variant is asserted
    // on a bottom rule, where it is the only candidate; the previous bar is bottom-neutral (0.1739% off the low).
    expect(
      evaluateRule(
        { ...params, side: "bottom" },
        withNeutralPrev(57.6, bar(10, 59, 59.5, 57.6, 59)),
      ),
    ).toMatchObject({
      details: { is_top: 0, anchor_price: 57.5, retrace_pct: 2.6087 },
    });
  });

  it("needs lookback anchor bars plus the judged bar", () => {
    // 4 bars for a lookback of 4: there is no bar left to judge.
    expect(evaluateRule(params, base.slice(-4))).toBeNull();
    // The same 4 bars are enough once the rule judges the last of them against the two before it; the previous
    // bar's 59.9 close is inside the band, so the judged bar is the leg's first.
    const short = [
      bar(6, 59.9, 60, 57.5, 59.9),
      bar(7, 59.9, 60, 57.5, 59.9),
      bar(8, 59.9, 60, 57.5, 59.9),
      bar(9, 56.5, 60, 56.5, 56.5),
    ];
    expect(evaluateRule({ ...params, side: "top", lookback: 2 }, short)).not.toBeNull();
    expect(
      evaluateRule({ ...params, side: "top" }, withNeutralPrev(59.9, bar(10, 56.5, 60, 56.5, 56.5))),
    ).not.toBeNull();

    expect(evaluateRule(params, [])).toBeNull();
  });
});

describe("rule interval, bar requirements and freshness", () => {
  it("reads price_cross on 1m and every other kind on its own interval", () => {
    expect(ruleInterval({ kind: "price_cross", level: 1, direction: "above" })).toBe("1m");
    expect(ruleInterval({ kind: "pct_move", interval: "5m", lookback: 3, minAbsPct: 1 })).toBe("5m");
    expect(ruleInterval({ kind: "ma_cross", period: 5, direction: "above", interval: "5m" })).toBe("5m");
    expect(ruleInterval({ kind: "retracement", interval: "15m", lookback: 20, minRetracePct: 0.3, side: "both" })).toBe("15m");
  });

  it("reports how many confirmed bars each kind reads", () => {
    expect(ruleBarsNeeded({ kind: "price_cross", level: 1, direction: "above" })).toBe(2);
    expect(ruleBarsNeeded({ kind: "candle_close_break", interval: "1m", level: 1, direction: "above" })).toBe(1);
    expect(ruleBarsNeeded({ kind: "long_wick", interval: "1m", minWickRatio: 0.5, side: "any" })).toBe(1);
    expect(ruleBarsNeeded({ kind: "volume_spike", interval: "1m", multiple: 2, lookback: 6 })).toBe(7);
    expect(ruleBarsNeeded({ kind: "pullback", interval: "1m", lookback: 20, minDropPct: 2 })).toBe(20);
    expect(ruleBarsNeeded({ kind: "pct_move", interval: "1m", lookback: 10, minAbsPct: 1 })).toBe(11);
    expect(ruleBarsNeeded({ kind: "ma_cross", period: 5, direction: "above", interval: "5m" })).toBe(2);
    expect(ruleBarsNeeded({ kind: "retracement", interval: "15m", lookback: 20, minRetracePct: 0.3, side: "both" })).toBe(21);
  });

  it("treats a bar as fresh for up to three intervals after it opens", () => {
    const open = 1_000_000_000_000;
    expect(isFreshBar(open, "1m", open + 60_000 + 30_000)).toBe(true);
    expect(isFreshBar(open, "1m", open + 3 * 60_000)).toBe(true);
    expect(isFreshBar(open, "1m", open + 3 * 60_000 + 1)).toBe(false);
    expect(isFreshBar(open, "1D", open + 2 * 86_400_000)).toBe(true);
  });
});

describe("cooldown and dedup", () => {
  it("blocks re-alerting inside the cooldown window only", () => {
    const last = 1_000_000;
    expect(isCooldownActive(null, 300, last)).toBe(false);
    expect(isCooldownActive(last, 300, last + 299_000)).toBe(true);
    expect(isCooldownActive(last, 300, last + 300_000)).toBe(false);
  });

  it("builds a per-rule, per-bar dedup key", () => {
    expect(alertDedupKey("abc", 1700000000000)).toBe("rule:abc:1700000000000");
  });
});
