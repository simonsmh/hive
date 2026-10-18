import { describe, expect, it } from "vitest";
import type { Candle } from "./types.js";
import {
  DEFAULT_REVERSAL_PARAMS,
  evaluateReversalInvalidation,
  evaluateReversalSetup,
  evaluateReversalTrigger,
  parseConditionalOrderInput,
  parseStrategyParams,
  reversalStopLevel,
  wilderRsi,
  type ReversalLongParams,
} from "./strategy.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-08-20T00:00:00Z");

function bar(ts: number, open: number, high: number, low: number, close: number): Candle {
  return { ts, open, high, low, close, volume: 1000, volCcy: 1000, confirmed: true };
}

/** Daily bars that drift up to `peak`, then capitulate to `low` on the last-but-`tail` bar and bounce slightly. */
function capitulationSeries(peak = 110, low = 96, tail = 1): Candle[] {
  const bars: Candle[] = [];
  let ts = T0;
  // 20 rising bars into the peak (also warms up RSI).
  for (let i = 0; i < 20; i += 1) {
    const close = 100 + (peak - 100) * (i / 19);
    bars.push(bar(ts, close - 0.4, close + 0.6, close - 0.6, close));
    ts += DAY;
  }
  // 6 falling bars into the capitulation low.
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    const close = peak - ((peak - low) * i) / steps;
    const barLow = i === steps ? low : close - 0.5;
    bars.push(bar(ts, close + 1, close + 1.2, barLow, close));
    ts += DAY;
  }
  // Tail bars hovering just above the low (no new low, no trigger-shaped bar).
  for (let i = 0; i < tail; i += 1) {
    bars.push(bar(ts, low + 1, low + 1.6, low + 0.4, low + 0.8));
    ts += DAY;
  }
  return bars;
}

const params = (overrides: Partial<ReversalLongParams> = {}): ReversalLongParams => ({
  ...DEFAULT_REVERSAL_PARAMS,
  lookbackDays: 25,
  setupWindowDays: 7,
  ...overrides,
});

describe("wilderRsi", () => {
  it("is null until the period is warmed up, then tracks direction", () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    const rsi = wilderRsi(rising, 14);
    expect(rsi[13]).toBeNull();
    expect(rsi[14]).toBe(100);
    expect(rsi[29]).toBe(100);

    const falling = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
    expect(wilderRsi(falling, 14)[29]).toBe(0);
  });
});

describe("parseStrategyParams", () => {
  it("applies defaults for an empty object", () => {
    expect(parseStrategyParams("reversal_long", {})).toEqual(DEFAULT_REVERSAL_PARAMS);
  });

  it("rejects unknown templates, bad intervals and out-of-range numbers", () => {
    expect(() => parseStrategyParams("nope", {})).toThrow(/unknown strategy template/);
    expect(() => parseStrategyParams("reversal_long", { interval: "4H" })).toThrow(/interval/);
    expect(() => parseStrategyParams("reversal_long", { minDrawdownPct: 0 })).toThrow(/minDrawdownPct/);
    expect(() => parseStrategyParams("reversal_long", { triggers: [] })).toThrow(/triggers/);
    expect(() => parseStrategyParams("reversal_long", { triggers: ["moon"] })).toThrow(/triggers/);
    expect(() => parseStrategyParams("reversal_long", { rsiMax: 90 })).toThrow(/rsiMax/);
  });

  it("dedupes triggers and accepts a null RSI gate", () => {
    const parsed = parseStrategyParams("reversal_long", { triggers: ["breakout", "breakout"], rsiMax: null });
    expect(parsed.triggers).toEqual(["breakout"]);
    expect(parsed.rsiMax).toBeNull();
  });
});

describe("evaluateReversalSetup", () => {
  it("primes on a capitulation: deep drawdown with an oversold window", () => {
    const setup = evaluateReversalSetup(capitulationSeries(), params());
    expect(setup).not.toBeNull();
    expect(setup!.setupLow).toBe(96);
    expect(setup!.refHigh).toBeGreaterThan(110);
    expect(setup!.drawdownPct).toBeGreaterThan(12);
    expect(setup!.windowMinRsi).not.toBeNull();
    expect(setup!.windowMinRsi!).toBeLessThanOrEqual(38);
  });

  it("stays unprimed when the drawdown is too shallow", () => {
    expect(evaluateReversalSetup(capitulationSeries(110, 103), params())).toBeNull();
  });

  it("stays unprimed when the RSI gate is not met even with a deep drawdown", () => {
    // A slow grind down keeps RSI mid-range: alternate small down/up closes to a deep low.
    const bars: Candle[] = [];
    let ts = T0;
    let price = 100;
    for (let i = 0; i < 26; i += 1) {
      bars.push(bar(ts, price, price + 0.5, price - 0.5, price));
      ts += DAY;
      price += i % 2 === 0 ? 0.9 : -1.4; // net drift up into the lookback high region first
    }
    // Force a one-day cliff at the end: RSI at the window still reflects the choppy path, not a single washout.
    const last = bars[bars.length - 1]!;
    bars.push(bar(ts, last.close, last.close + 0.3, last.close * 0.86, last.close * 0.87));
    const strict = evaluateReversalSetup(bars, params({ rsiMax: 20 }));
    expect(strict).toBeNull();
  });

  it("ignores a low that fell out of the setup window", () => {
    const bars = capitulationSeries(110, 96, 0);
    const lastTs = bars[bars.length - 1]!.ts;
    // Price recovered ~10 bars ago; the recent window's low is far above the capitulation low.
    for (let i = 1; i <= 10; i += 1) {
      bars.push(bar(lastTs + i * DAY, 105, 106.2, 104.5, 105.6));
    }
    expect(evaluateReversalSetup(bars, params())).toBeNull();
  });
});

describe("evaluateReversalTrigger", () => {
  const setupOf = (bars: Candle[]) => {
    const setup = evaluateReversalSetup(bars, params());
    if (!setup) throw new Error("fixture did not prime");
    return setup;
  };

  it("does not fire on the setup low bar itself or while hovering", () => {
    const bars = capitulationSeries();
    const setup = setupOf(bars);
    expect(evaluateReversalTrigger(bars, params(), setup)).toBeNull();
  });

  it("fires breakout when a later bar closes above the post-low range high", () => {
    const bars = capitulationSeries();
    const setup = setupOf(bars);
    const lastTs = bars[bars.length - 1]!.ts;
    bars.push(bar(lastTs + DAY, 98, 99, 97.5, 97.4)); // stays below the post-low range high (99)
    expect(evaluateReversalTrigger(bars, params(), setup)).toBeNull();
    bars.push(bar(lastTs + 2 * DAY, 98.6, 100.4, 98.2, 100.1)); // close above every post-low high
    const trigger = evaluateReversalTrigger(bars, params(), setup);
    expect(trigger?.kind).toBe("breakout");
    expect(trigger?.close).toBe(100.1);
    expect(trigger?.rangeHigh).toBe(99);
  });

  it("fires strong_close on a big up day closing near its high", () => {
    const bars = capitulationSeries();
    const setup = setupOf(bars);
    const lastTs = bars[bars.length - 1]!.ts;
    bars.push(bar(lastTs + DAY, 97, 101.5, 96.8, 101.2)); // +4.4% vs prev close, closes at the top
    const trigger = evaluateReversalTrigger(bars, params({ triggers: ["strong_close"] }), setup);
    expect(trigger?.kind).toBe("strong_close");
  });

  it("fires engulfing and hammer by their shapes", () => {
    const bars = capitulationSeries();
    const setup = setupOf(bars);
    const lastTs = bars[bars.length - 1]!.ts;
    const engulfing = [...bars, bar(lastTs + DAY, 96.6, 98.4, 96.4, 98.2)];
    expect(evaluateReversalTrigger(engulfing, params({ triggers: ["engulfing"] }), setup)?.kind).toBe("engulfing");
    const hammer = [...bars, bar(lastTs + DAY, 97.4, 97.9, 95.9, 97.8)];
    expect(evaluateReversalTrigger(hammer, params({ triggers: ["hammer"] }), setup)?.kind).toBe("hammer");
  });

  it("respects the trigger order in params", () => {
    const bars = capitulationSeries();
    const setup = setupOf(bars);
    const lastTs = bars[bars.length - 1]!.ts;
    // This bar is both a strong close and a breakout; strong_close is listed first.
    bars.push(bar(lastTs + DAY, 97, 102, 96.8, 101.6));
    const trigger = evaluateReversalTrigger(bars, params({ triggers: ["strong_close", "breakout"] }), setup);
    expect(trigger?.kind).toBe("strong_close");
  });
});

describe("invalidation and stop level", () => {
  it("anchors the stop below the setup low and invalidates on a daily close through it", () => {
    const bars = capitulationSeries();
    const setup = evaluateReversalSetup(bars, params())!;
    const stop = reversalStopLevel(setup.setupLow, params().stopBufferPct);
    expect(stop).toBeCloseTo(96 * 0.985, 6);
    expect(evaluateReversalInvalidation(bars, setup, stop)).toBe(false);
    const lastTs = bars[bars.length - 1]!.ts;
    const broken = [...bars, bar(lastTs + DAY, 95.5, 95.8, 93.9, 94.1)];
    expect(evaluateReversalInvalidation(broken, setup, stop)).toBe(true);
  });
});

describe("parseConditionalOrderInput", () => {
  const now = Date.parse("2026-10-18T00:00:00Z");
  const base = {
    instId: "NVDA-USDT-SWAP",
    lever: 3,
    sz: "0.01",
    theme: "reversal-oct",
    themeStopCapU: 0.1,
    expiresInDays: 14,
  };

  it("accepts a minimal live order and fills defaults", () => {
    const parsed = parseConditionalOrderInput(base, now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mode).toBe("live");
    expect(parsed.value.template).toBe("reversal_long");
    expect(parsed.value.tdMode).toBe("isolated");
    expect(parsed.value.expiresAt).toBe("2026-11-01T00:00:00.000Z");
    expect(parsed.value.params).toEqual(DEFAULT_REVERSAL_PARAMS);
  });

  it("rejects bad instruments, oversized stop caps and past expiries", () => {
    expect(parseConditionalOrderInput({ ...base, instId: "NVDA-USD-SWAP" }, now)).toEqual({
      ok: false,
      error: expect.stringContaining("instId"),
    });
    expect(parseConditionalOrderInput({ ...base, themeStopCapU: 0.2 }, now).ok).toBe(false);
    expect(parseConditionalOrderInput({ ...base, expiresAt: "2026-10-01T00:00:00Z" }, now).ok).toBe(false);
    expect(parseConditionalOrderInput({ ...base, sz: "0" }, now).ok).toBe(false);
    expect(parseConditionalOrderInput({ ...base, params: { interval: "4H" } }, now).ok).toBe(false);
  });
});
