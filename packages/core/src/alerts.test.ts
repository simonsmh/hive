import { describe, expect, it } from "vitest";
import {
  AlertRuleError,
  alertDedupKey,
  evaluateCandleCloseBreak,
  evaluateLongWick,
  evaluatePctMove,
  evaluatePriceCross,
  evaluatePullback,
  evaluateRule,
  evaluateVolumeSpike,
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
    expect(parseRuleParams("long_wick", { interval: "1m" })).toMatchObject({ minWickRatio: 0.6, side: "any" });
    expect(parseRuleParams("pullback", { interval: "15m", minDropPct: 2 })).toMatchObject({ lookback: 20 });
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
    expect(evaluateRule(spike, quiet)).toMatchObject({ details: { last_volume: 400, multiple: 3 } });
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

describe("rule interval, bar requirements and freshness", () => {
  it("reads price_cross on 1m and every other kind on its own interval", () => {
    expect(ruleInterval({ kind: "price_cross", level: 1, direction: "above" })).toBe("1m");
    expect(ruleInterval({ kind: "pct_move", interval: "5m", lookback: 3, minAbsPct: 1 })).toBe("5m");
  });

  it("reports how many confirmed bars each kind reads", () => {
    expect(ruleBarsNeeded({ kind: "price_cross", level: 1, direction: "above" })).toBe(2);
    expect(ruleBarsNeeded({ kind: "candle_close_break", interval: "1m", level: 1, direction: "above" })).toBe(1);
    expect(ruleBarsNeeded({ kind: "long_wick", interval: "1m", minWickRatio: 0.5, side: "any" })).toBe(1);
    expect(ruleBarsNeeded({ kind: "volume_spike", interval: "1m", multiple: 2, lookback: 6 })).toBe(7);
    expect(ruleBarsNeeded({ kind: "pullback", interval: "1m", lookback: 20, minDropPct: 2 })).toBe(20);
    expect(ruleBarsNeeded({ kind: "pct_move", interval: "1m", lookback: 10, minAbsPct: 1 })).toBe(11);
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
