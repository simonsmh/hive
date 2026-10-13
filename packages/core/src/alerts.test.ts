import { describe, expect, it } from "vitest";
import {
  AlertRuleError,
  alertDedupKey,
  evaluateCandleCloseBreak,
  evaluateLongWick,
  evaluatePriceCross,
  evaluatePullback,
  evaluateVolumeSpike,
  isCooldownActive,
  parseRuleParams,
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
