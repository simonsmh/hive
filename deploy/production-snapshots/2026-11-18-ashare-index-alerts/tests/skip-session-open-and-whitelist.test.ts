import { describe, expect, it } from "vitest";
import {
  AlertRuleError,
  evaluateVolumeSpike,
  isSessionOpenSkipBar,
  parseRuleParams,
} from "../alert-evaluator/core/alerts.ts";
import type { Candle } from "../alert-evaluator/core/types.ts";
import { INTRADAY_WHITELIST, toSinaIntradayTargets } from "../sina-intraday-collector/handler.ts";

/** 2026-11-18 09:30 Asia/Shanghai, a real session open. */
const OPEN_0930_MS = Date.UTC(2026, 10, 18, 1, 30, 0);
const BAR_0935_MS = OPEN_0930_MS + 5 * 60_000;
const BAR_1300_MS = Date.UTC(2026, 10, 18, 5, 0, 0);

function candle(ts: number, volume: number, open = 100, close = 100.5): Candle {
  return { ts, open, high: Math.max(open, close), low: Math.min(open, close), close, volume, volCcy: 0, confirmed: true };
}

const indexRule = {
  kind: "volume_spike" as const,
  interval: "5m" as const,
  lookback: 20,
  multiple: 2,
  minMovePct: 0.3,
  skipSessionOpenBars: 1,
};

function historyThen(last: Candle, priorVolume = 100): Candle[] {
  const prior = Array.from({ length: 20 }, (_, i) => candle(last.ts - (20 - i) * 5 * 60_000, priorVolume));
  return [...prior, last];
}

describe("parseRuleParams skipSessionOpenBars", () => {
  it("accepts 0 through 6 and omits the field when absent", () => {
    const base = { interval: "5m", multiple: 2, lookback: 20, minMovePct: 0.3 };
    expect(parseRuleParams("volume_spike", base)).not.toHaveProperty("skipSessionOpenBars");
    expect(parseRuleParams("volume_spike", { ...base, skipSessionOpenBars: 0 })).toMatchObject({ skipSessionOpenBars: 0 });
    expect(parseRuleParams("volume_spike", { ...base, skipSessionOpenBars: 1 })).toMatchObject({ skipSessionOpenBars: 1 });
    expect(parseRuleParams("volume_spike", { ...base, skipSessionOpenBars: 6 })).toMatchObject({ skipSessionOpenBars: 6 });
  });

  it("rejects out-of-range or non-integer skipSessionOpenBars", () => {
    const base = { interval: "5m", multiple: 2, lookback: 20 };
    expect(() => parseRuleParams("volume_spike", { ...base, skipSessionOpenBars: 7 })).toThrow(AlertRuleError);
    expect(() => parseRuleParams("volume_spike", { ...base, skipSessionOpenBars: -1 })).toThrow(AlertRuleError);
    expect(() => parseRuleParams("volume_spike", { ...base, skipSessionOpenBars: 1.5 })).toThrow(AlertRuleError);
  });
});

describe("isSessionOpenSkipBar", () => {
  it("skips only the first N 5m bars from 09:30 Asia/Shanghai", () => {
    expect(isSessionOpenSkipBar(OPEN_0930_MS, "5m", 1)).toBe(true);
    expect(isSessionOpenSkipBar(BAR_0935_MS, "5m", 1)).toBe(false);
    expect(isSessionOpenSkipBar(BAR_1300_MS, "5m", 1)).toBe(false);
    expect(isSessionOpenSkipBar(OPEN_0930_MS, "5m", 0)).toBe(false);
    expect(isSessionOpenSkipBar(OPEN_0930_MS, "1D", 1)).toBe(false);
    expect(isSessionOpenSkipBar(BAR_0935_MS, "5m", 2)).toBe(true);
  });
});

describe("evaluateVolumeSpike with the production index params", () => {
  it("does not fire on the 09:30 bar even with a 5x volume and a 0.8% body", () => {
    const last = candle(OPEN_0930_MS, 500, 100, 100.8);
    expect(evaluateVolumeSpike(indexRule, historyThen(last, 100))).toBe(false);
    expect(evaluateVolumeSpike({ ...indexRule, skipSessionOpenBars: 0 }, historyThen(last, 100))).toBe(true);
  });

  it("still fires on 09:35 when volume and body clear the thresholds", () => {
    const last = candle(BAR_0935_MS, 250, 100, 100.4);
    expect(evaluateVolumeSpike(indexRule, historyThen(last, 100))).toBe(true);
  });

  it("does not fire at lunch 13:00 solely because the session resumed", () => {
    const last = candle(BAR_1300_MS, 150, 100, 100.1);
    expect(evaluateVolumeSpike(indexRule, historyThen(last, 100))).toBe(false);
    expect(isSessionOpenSkipBar(BAR_1300_MS, "5m", 1)).toBe(false);
  });

  it("requires both 2x volume and a 0.3% body after the open skip", () => {
    // Use 1000/1003 so the 0.3% body is exact in IEEE floats (100.3 is not).
    expect(evaluateVolumeSpike(indexRule, historyThen(candle(BAR_0935_MS, 199, 1000, 1005), 100))).toBe(false);
    expect(evaluateVolumeSpike(indexRule, historyThen(candle(BAR_0935_MS, 200, 1000, 1002.9), 100))).toBe(false);
    expect(evaluateVolumeSpike(indexRule, historyThen(candle(BAR_0935_MS, 200, 1000, 1003), 100))).toBe(true);
  });
});

describe("INTRADAY_WHITELIST and toSinaIntradayTargets", () => {
  it("includes the three indices as themselves plus the pre-existing names", () => {
    expect([...INTRADAY_WHITELIST]).toEqual([
      "SH513310",
      "HTGD",
      "SZ159915",
      "SH000300",
      "SH000688",
      "SZ399006",
    ]);
  });

  it("keeps only whitelisted symbols that have a mappable ths_code", () => {
    const logs: string[] = [];
    const targets = toSinaIntradayTargets(
      [
        { symbol: "SH000688", thsCode: "000688.SH" },
        { symbol: "SZ399006", thsCode: "399006.SZ" },
        { symbol: "SH000300", thsCode: "000300.SH" },
        { symbol: "SH513310", thsCode: "513310.SH" },
        { symbol: "SZ159915", thsCode: "159915.SZ" },
        { symbol: "HTGD", thsCode: "600487.SH" },
        { symbol: "SH000001", thsCode: "000001.SH" },
        { symbol: "BTC", thsCode: null },
      ],
      (message) => logs.push(message),
    );
    expect(targets.map((t) => [t.symbol, t.sinaCode])).toEqual([
      ["SH000688", "sh000688"],
      ["SZ399006", "sz399006"],
      ["SH000300", "sh000300"],
      ["SH513310", "sh513310"],
      ["SZ159915", "sz159915"],
      ["HTGD", "sh600487"],
    ]);
    expect(logs).toEqual(["skipped 1 symbols outside the intraday whitelist"]);
  });
});
