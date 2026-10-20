import { describe, expect, it } from "vitest";
import type { Candle } from "./types.js";
import {
  checkAtrExpansion,
  checkBreakout,
  checkTrendRegime,
  checkTriggerBar,
  checkVolume,
  computeTrendSize,
  countPeerConfirmations,
  EMPTY_TREND_STATE,
  evaluateTrendExit,
  evaluateTrendTrigger,
  nextPeakAtr,
  parseTrendParams,
  parseTrendState,
  parseTrendStrategyInput,
  planAlgoReconcile,
  planTrendAdd,
  revalidateAddStop,
  roundTrendStop,
  trendBarsNeeded,
  trendInitialStop,
  worstCaseLossU,
  type TrendAlgoView,
  type TrendParams,
  type TrendRuntimeState,
} from "./trend.js";

function bar(ts: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { ts, open, high, low, close, volume, volCcy: volume, confirmed: true };
}

/** Small, fast parameters so scenarios fit in a handful of bars. */
function params(overrides: Record<string, unknown> = {}): TrendParams {
  return parseTrendParams({
    atrLen: 2,
    expansionWindow: 3,
    expansionMultiple: 1.1,
    donchianLen: 3,
    volumeLen: 3,
    volumeMultiple: 1.5,
    triggerTrMultiple: 1.2,
    clvBand: 0.25,
    erLen: 2,
    erMin: 0.2,
    addStepAtr: 0.5,
    maxAdds: 2,
    atrDecayExitPct: 28,
    maExitLen: 4,
    stopBufferAtr: 0.5,
    ...overrides,
  });
}

/** Quiet base, then one fat high-volume breakout bar. Hand-computed in the composed test below. */
function breakoutSeries(lastVolume = 300): Candle[] {
  return [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 101, 99, 100.5),
    bar(2, 100.5, 101.5, 99.5, 101),
    bar(3, 101, 102, 100, 101.5),
    bar(4, 101.5, 110, 101, 109, lastVolume),
  ];
}

describe("checkAtrExpansion", () => {
  it("passes when the current ATR makes a window high and clears the scaled mean", () => {
    // prior max over the 3 before last = 1; mean of the last 3 incl current = 1.5; 2 >= 1.1 * 1.5.
    const check = checkAtrExpansion([1, 1, 1, 1, 2], { expansionWindow: 3, expansionMultiple: 1.1 });
    expect(check.pass).toBe(true);
    expect(check.atr).toBe(2);
    expect(check.priorMax).toBe(1);
  });

  it("fails when the current ATR is not the window high", () => {
    const check = checkAtrExpansion([1, 2, 1, 1, 1.5], { expansionWindow: 3, expansionMultiple: 1.1 });
    expect(check.pass).toBe(false);
    expect(check.priorMax).toBe(2);
  });

  it("fails when the mean gate is not cleared", () => {
    const check = checkAtrExpansion([1, 1, 1, 1, 1.05], { expansionWindow: 3, expansionMultiple: 1.5 });
    expect(check.pass).toBe(false);
  });
});

describe("checkTriggerBar", () => {
  it("passes a fat bar closing at its top for a long", () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 112, 100, 111)];
    // TR = 12, CLV = 11/12 >= 0.75, 12 >= 1.2 * 5.
    const check = checkTriggerBar(bars, 5, "long", { triggerTrMultiple: 1.2, clvBand: 0.25 });
    expect(check.pass).toBe(true);
    expect(check.tr).toBe(12);
  });

  it("fails a fat bar that closes mid-range", () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 112, 100, 104)];
    expect(checkTriggerBar(bars, 5, "long", { triggerTrMultiple: 1.2, clvBand: 0.25 }).pass).toBe(false);
  });

  it("passes the mirror image for a short", () => {
    const bars = [bar(0, 112, 113, 111, 112), bar(1, 112, 112, 100, 101)];
    expect(checkTriggerBar(bars, 5, "short", { triggerTrMultiple: 1.2, clvBand: 0.25 }).pass).toBe(true);
  });
});

describe("checkBreakout", () => {
  it("fires when the close crosses the prior channel edge and reports the level", () => {
    const check = checkBreakout(breakoutSeries(), "long", { donchianLen: 3 });
    expect(check.pass).toBe(true);
    expect(check.level).toBe(102);
  });

  it("does not fire while the close stays inside the channel", () => {
    const bars = breakoutSeries();
    bars[4] = bar(4, 101.5, 102.5, 101, 101.8, 300);
    expect(checkBreakout(bars, "long", { donchianLen: 3 }).pass).toBe(false);
  });
});

describe("checkVolume", () => {
  it("compares the last bar against the mean of the bars before it", () => {
    expect(checkVolume(breakoutSeries(300), { volumeLen: 3, volumeMultiple: 1.5 }).pass).toBe(true);
    expect(checkVolume(breakoutSeries(149), { volumeLen: 3, volumeMultiple: 1.5 }).pass).toBe(false);
  });
});

describe("countPeerConfirmations", () => {
  it("counts only peers breaking out in the direction", () => {
    const flat = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 101, 99, 100.2)];
    expect(countPeerConfirmations([breakoutSeries(), flat], "long", { donchianLen: 3 }, 4)).toBe(1);
    expect(countPeerConfirmations([breakoutSeries(), flat], "short", { donchianLen: 3 }, 4)).toBe(0);
  });

  it("does not count a peer whose newest bar is stale relative to the primary bar", () => {
    // The same breakout shape, but the peer's feed stalled one bar ago: its latest bar is ts 3
    // while the primary series is deciding on ts 4. The old breakout must not confirm anything.
    const stalled = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100.5),
      bar(2, 100.5, 101.5, 99.5, 101),
      bar(3, 101, 110, 100, 109),
    ];
    expect(countPeerConfirmations([stalled], "long", { donchianLen: 3 }, 4)).toBe(0);
    expect(countPeerConfirmations([stalled], "long", { donchianLen: 3 }, 3)).toBe(1);
    expect(countPeerConfirmations([breakoutSeries()], "long", { donchianLen: 3 }, null)).toBe(0);
  });
});

describe("roundTrendStop", () => {
  it("rounds toward the position, never away from it", () => {
    expect(roundTrendStop("long", 109.385, 0.01)).toBe(109.39);
    expect(roundTrendStop("short", 109.385, 0.01)).toBe(109.38);
    expect(roundTrendStop("long", 109.38, 0.05)).toBe(109.4);
    expect(roundTrendStop("short", 109.38, 0.05)).toBe(109.35);
  });

  it("leaves an on-tick stop untouched", () => {
    expect(roundTrendStop("long", 109.38, 0.01)).toBe(109.38);
    expect(roundTrendStop("short", 109.38, 0.01)).toBe(109.38);
  });

  it("never widens the worst-case loss a plan was verified against", () => {
    const longStop = 109.385;
    expect(worstCaseLossU("long", 2, 111, roundTrendStop("long", longStop, 0.01), 1)).toBeLessThanOrEqual(
      worstCaseLossU("long", 2, 111, longStop, 1),
    );
    const shortStop = 110.615;
    expect(worstCaseLossU("short", 2, 108, roundTrendStop("short", shortStop, 0.01), 1)).toBeLessThanOrEqual(
      worstCaseLossU("short", 2, 108, shortStop, 1),
    );
  });
});

describe("checkTrendRegime", () => {
  it("passes a straight-line path and fails chop", () => {
    const straight = [10, 11, 12, 13, 14].map((close, i) => bar(i, close, close, close, close));
    expect(checkTrendRegime(straight, { erLen: 2, erMin: 0.3 }).pass).toBe(true);
    const chop = [10, 12, 10, 12, 10].map((close, i) => bar(i, close, close, close, close));
    expect(checkTrendRegime(chop, { erLen: 2, erMin: 0.3 }).pass).toBe(false);
  });
});

describe("evaluateTrendTrigger", () => {
  it("fires when every gate passes and reports the base level and ATR", () => {
    const result = evaluateTrendTrigger(breakoutSeries(), [], params(), "long");
    expect(result.fired).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.baseLevel).toBe(102);
    expect(result.close).toBe(109);
    // ATR series (len 2): seed 2, then 2, then (2 + 9) / 2 = 5.5.
    expect(result.atr).toBe(5.5);
  });

  it("names the failed gate when one gate blocks the fire", () => {
    const result = evaluateTrendTrigger(breakoutSeries(100), [], params(), "long");
    expect(result.fired).toBe(false);
    expect(result.failedChecks).toContain("volume");
  });

  it("honours the peer gate", () => {
    const p = params({ peerInstIds: ["QQQ-USDT-SWAP"], peerMinCount: 1 });
    expect(evaluateTrendTrigger(breakoutSeries(), [], p, "long").failedChecks).toContain("peers");
    expect(evaluateTrendTrigger(breakoutSeries(), [breakoutSeries()], p, "long").fired).toBe(true);
  });
});

describe("trendInitialStop", () => {
  it("sits stopBufferAtr beyond the base edge, against the position", () => {
    expect(trendInitialStop("long", 102, 5.5, { stopBufferAtr: 0.5 })).toBe(99.25);
    expect(trendInitialStop("short", 98, 5.5, { stopBufferAtr: 0.5 })).toBe(100.75);
  });
});

describe("computeTrendSize", () => {
  it("sizes from the risk budget and floors to whole lots", () => {
    // 0.1 / (|109 - 99.25| * 1) = 0.01025... -> one lot of 0.01.
    expect(computeTrendSize(0.1, 109, 99.25, 1, 0.01, 0.01)).toBe("0.01");
    expect(computeTrendSize(0.2, 109, 99.25, 1, 0.01, 0.01)).toBe("0.02");
  });

  it("returns null when even the minimum size busts the budget", () => {
    expect(computeTrendSize(0.05, 109, 99.25, 1, 0.01, 0.01)).toBeNull();
    expect(computeTrendSize(0.1, 109, 99.25, 10, 0.01, 0.01)).toBeNull();
  });
});

describe("worstCaseLossU", () => {
  it("is the cash loss at the stop, and zero when the stop locks a gain", () => {
    expect(worstCaseLossU("long", 0.02, 105, 99.25, 1)).toBeCloseTo(0.115);
    expect(worstCaseLossU("long", 0.02, 105, 110, 1)).toBe(0);
    expect(worstCaseLossU("short", 0.02, 95, 100.75, 1)).toBeCloseTo(0.115);
  });
});

describe("revalidateAddStop", () => {
  it("keeps the planned stop when the observed fill respects the cap", () => {
    const r = revalidateAddStop("long", 0.03, 100, 98, 97, 0.1, 1);
    expect(r.tightened).toBe(false);
    expect(r.stopPx).toBe(98);
    expect(r.aggregateLossU).toBeCloseTo(0.06);
  });

  it("tightens a long stop to the cap-implied level on an adverse fill", () => {
    const r = revalidateAddStop("long", 0.03, 102, 98, 97, 0.1, 1);
    expect(r.tightened).toBe(true);
    expect(r.stopPx).toBeCloseTo(98.6667, 4);
    // The tightened stop restores the invariant exactly.
    expect(worstCaseLossU("long", 0.03, 102, r.stopPx, 1)).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("tightens a short stop to the cap-implied level on an adverse fill", () => {
    const r = revalidateAddStop("short", 0.03, 98, 102, 103, 0.1, 1);
    expect(r.tightened).toBe(true);
    expect(r.stopPx).toBeCloseTo(101.3333, 4);
    expect(worstCaseLossU("short", 0.03, 98, r.stopPx, 1)).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("never moves the stop against the current stop", () => {
    // Defensive path: current stop tighter than planned; the clamp keeps it.
    const r = revalidateAddStop("long", 0.03, 100, 98, 99.5, 0.05, 1);
    expect(r.tightened).toBe(true);
    expect(r.stopPx).toBe(99.5);
  });

  it("does not tighten when the aggregate loss is exactly at the cap", () => {
    const r = revalidateAddStop("long", 0.1, 100, 99, 98, 0.1, 1);
    expect(r.aggregateLossU).toBe(0.1);
    expect(r.tightened).toBe(false);
    expect(r.stopPx).toBe(99);
  });
});

function activeState(overrides: Partial<TrendRuntimeState> = {}): TrendRuntimeState {
  return {
    ...EMPTY_TREND_STATE,
    entryPx: 109,
    entryBarTs: 4,
    entryAtr: 5.5,
    peakAtr: 5.5,
    stopPx: 99.25,
    positionSz: 0.01,
    adds: 0,
    lastAddAnchorPx: 109,
    ...overrides,
  };
}

describe("planTrendAdd", () => {
  const ctx = (overrides: Partial<Parameters<typeof planTrendAdd>[1]> = {}): Parameters<typeof planTrendAdd>[1] => ({
    direction: "long",
    params: params(),
    bar: bar(5, 112, 114, 112, 113),
    atr: 5.5,
    ctVal: 1,
    lotSz: 0.01,
    minSz: 0.01,
    firstSz: 0.01,
    themeStopCapU: 0.1,
    ...overrides,
  });

  it("plans an add after a full step, trailing the unified stop to the add bar's base", () => {
    // Excursion 113 - 109 = 4 >= 0.5 * 5.5. Candidate stop = 112 - 2.75 = 109.25 > 99.25.
    // Blended avg = 111, loss = (111 - 109.25) * 0.02 = 0.035 <= 0.1.
    const plan = planTrendAdd(activeState(), ctx());
    expect(plan).toMatchObject({ add: true, sz: "0.01", newStopPx: 109.25 });
    if (plan.add) expect(plan.worstCaseLossU).toBeCloseTo(0.035);
  });

  it("does not plan before the step is travelled", () => {
    const plan = planTrendAdd(activeState(), ctx({ bar: bar(5, 109.5, 111, 109, 110) }));
    expect(plan).toEqual({ add: false, reason: "step_not_reached" });
  });

  it("shrinks the add by whole lots until the risk invariant holds", () => {
    // firstSz 0.02 busts a 0.05 cap at full size (loss 0.0726); one lot fits (0.035).
    const plan = planTrendAdd(activeState(), ctx({ firstSz: 0.02, themeStopCapU: 0.05 }));
    expect(plan).toMatchObject({ add: true, sz: "0.01" });
  });

  it("refuses the add when no lot size satisfies the cap", () => {
    const plan = planTrendAdd(activeState(), ctx({ themeStopCapU: 0.02 }));
    expect(plan).toEqual({ add: false, reason: "risk_cap" });
  });

  it("stops at maxAdds and without a position", () => {
    expect(planTrendAdd(activeState({ adds: 2 }), ctx())).toEqual({ add: false, reason: "max_adds_reached" });
    expect(planTrendAdd({ ...EMPTY_TREND_STATE }, ctx())).toEqual({ add: false, reason: "no_position" });
  });

  it("mirrors for shorts and never moves the stop against the position", () => {
    const shortState = activeState({ entryPx: 100, stopPx: 110, lastAddAnchorPx: 100 });
    const plan = planTrendAdd(
      shortState,
      ctx({ direction: "short", bar: bar(5, 97, 97.5, 94, 96), atr: 4 }),
    );
    // Excursion 4 >= 2. Candidate = 97.5 + 2 = 99.5 < 110, so the stop trails to 99.5.
    expect(plan).toMatchObject({ add: true, newStopPx: 99.5 });
  });
});

describe("evaluateTrendExit", () => {
  it("exits on ATR decay from the peak since entry", () => {
    const calm = [0, 1, 2, 3, 4].map((i) => bar(i, 100, 100.5, 99.5, 100));
    const decision = evaluateTrendExit(calm, activeState({ peakAtr: 10 }), params(), "long");
    expect(decision.exit).toBe(true);
    expect(decision.reason).toBe("atr_decay");
  });

  it("exits when the close falls through the slow MA", () => {
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 100, 101, 99, 100),
      bar(3, 100, 101, 99, 100),
      bar(4, 100, 101, 99, 100),
      bar(5, 95, 100, 89, 90),
    ];
    const decision = evaluateTrendExit(bars, activeState({ peakAtr: 1 }), params(), "long");
    expect(decision.exit).toBe(true);
    expect(decision.reason).toBe("ma_cross");
    expect(decision.ma).toBeCloseTo(97.5);
  });

  it("holds while the trend is intact", () => {
    const decision = evaluateTrendExit(breakoutSeries(), activeState({ peakAtr: 5.5 }), params(), "long");
    expect(decision.exit).toBe(false);
  });
});

describe("planAlgoReconcile", () => {
  const algo = (overrides: Partial<TrendAlgoView> = {}): TrendAlgoView => ({
    algoId: "a1",
    side: "sell",
    posSide: "net",
    reduceOnly: true,
    sz: 0.01,
    slTriggerPx: "100",
    ...overrides,
  });
  const desired = { size: 0.02, stopPx: 100, lotSz: 0.01, tickSz: 0.01 };

  it("plans nothing when the set is exact, even split across algos at the stop", () => {
    expect(planAlgoReconcile(desired, [algo(), algo({ algoId: "a2" })], "long", "net")).toEqual([]);
  });

  it("plans one amend when coverage is partial or at the wrong stop", () => {
    expect(planAlgoReconcile(desired, [algo()], "long", "net")).toEqual([
      { kind: "amend_tpsl", sz: "0.02", slTriggerPx: "100.00" },
    ]);
    expect(planAlgoReconcile(desired, [algo({ sz: 0.02, slTriggerPx: "99" })], "long", "net")).toEqual([
      { kind: "amend_tpsl", sz: "0.02", slTriggerPx: "100.00" },
    ]);
  });

  it("ignores non-protective algos (TP-only, wrong side, not reduce-only)", () => {
    const noise = [
      algo({ slTriggerPx: null }),
      algo({ algoId: "a3", side: "buy", sz: 0.02 }),
      algo({ algoId: "a4", reduceOnly: false, sz: 0.02 }),
    ];
    expect(planAlgoReconcile(desired, noise, "long", "net")).toEqual([
      { kind: "amend_tpsl", sz: "0.02", slTriggerPx: "100.00" },
    ]);
  });

  it("plans a cancel of leftovers when the position is flat", () => {
    expect(planAlgoReconcile({ ...desired, size: 0 }, [algo()], "long", "net")).toEqual([
      { kind: "cancel_algos", algoIds: ["a1"] },
    ]);
    expect(planAlgoReconcile({ ...desired, size: 0 }, [], "long", "net")).toEqual([]);
  });

  it("excludes ignored algo ids from planning (external protection is not ours to manage)", () => {
    // Our own algo is exact; an external algo at another stop must not trigger an amend.
    expect(planAlgoReconcile(desired, [algo({ sz: 0.02 }), algo({ algoId: "ext", sz: 0.05, slTriggerPx: "90" })], "long", "net", ["ext"])).toEqual([]);
    // Without the ignore list the same external algo would drive amend churn.
    expect(planAlgoReconcile(desired, [algo({ sz: 0.02 }), algo({ algoId: "ext", sz: 0.05, slTriggerPx: "90" })], "long", "net")).toEqual([
      { kind: "amend_tpsl", sz: "0.02", slTriggerPx: "100.00" },
    ]);
    // An external algo at the same stop no longer inflates coverage.
    expect(planAlgoReconcile(desired, [algo({ sz: 0.02 }), algo({ algoId: "ext", sz: 0.05 })], "long", "net", ["ext"])).toEqual([]);
    // Ignoring everything still plans an amend when our own protection is missing.
    expect(planAlgoReconcile(desired, [algo({ algoId: "ext", sz: 0.02 })], "long", "net", ["ext"])).toEqual([
      { kind: "amend_tpsl", sz: "0.02", slTriggerPx: "100.00" },
    ]);
  });
});

describe("state helpers", () => {
  it("parseTrendState tolerates garbage and keeps valid fields", () => {
    expect(parseTrendState(null)).toEqual(EMPTY_TREND_STATE);
    expect(parseTrendState("nope")).toEqual(EMPTY_TREND_STATE);
    const parsed = parseTrendState({ entryPx: 109, positionSz: 0.02, adds: 1, peakAtr: "x" });
    expect(parsed.entryPx).toBe(109);
    expect(parsed.positionSz).toBe(0.02);
    expect(parsed.adds).toBe(1);
    expect(parsed.peakAtr).toBeNull();
  });

  it("parseTrendState round-trips protectiveAlgoId and pendingAdd, dropping malformed values", () => {
    const parsed = parseTrendState({
      protectiveAlgoId: "algo-1",
      pendingAdd: { szNum: 0.01, barTs: 123, newStopPx: 99, anchorPx: 101 },
    });
    expect(parsed.protectiveAlgoId).toBe("algo-1");
    expect(parsed.pendingAdd).toEqual({ szNum: 0.01, barTs: 123, newStopPx: 99, anchorPx: 101 });
    expect(parseTrendState({ protectiveAlgoId: 42 }).protectiveAlgoId).toBeNull();
    expect(parseTrendState({ pendingAdd: { szNum: 0.01 } }).pendingAdd).toBeNull();
    expect(parseTrendState({ pendingAdd: "x" }).pendingAdd).toBeNull();
  });

  it("parseTrendState defaults openVerified to true, keeps an explicit false", () => {
    expect(parseTrendState({}).openVerified).toBe(true);
    expect(parseTrendState({ openVerified: true }).openVerified).toBe(true);
    expect(parseTrendState({ openVerified: false }).openVerified).toBe(false);
    expect(parseTrendState({ openVerified: "yes" }).openVerified).toBe(true);
  });

  it("parseTrendState round-trips initialUnitSz, defaulting to null for legacy rows", () => {
    expect(parseTrendState({}).initialUnitSz).toBeNull();
    expect(parseTrendState({ initialUnitSz: 0.01 }).initialUnitSz).toBe(0.01);
    expect(parseTrendState({ initialUnitSz: "0.01" }).initialUnitSz).toBeNull();
    expect(EMPTY_TREND_STATE.initialUnitSz).toBeNull();
  });

  it("parseTrendState round-trips closeAttempts, defaulting to 0 for legacy rows", () => {
    expect(parseTrendState({}).closeAttempts).toBe(0);
    expect(parseTrendState({ closeAttempts: 2 }).closeAttempts).toBe(2);
    expect(parseTrendState({ closeAttempts: -1 }).closeAttempts).toBe(0);
    expect(parseTrendState({ closeAttempts: 1.5 }).closeAttempts).toBe(0);
    expect(parseTrendState({ closeAttempts: "2" }).closeAttempts).toBe(0);
    expect(EMPTY_TREND_STATE.closeAttempts).toBe(0);
  });

  it("nextPeakAtr only grows", () => {
    expect(nextPeakAtr({ peakAtr: 5 }, 4)).toBe(5);
    expect(nextPeakAtr({ peakAtr: 5 }, 6)).toBe(6);
    expect(nextPeakAtr({ peakAtr: null }, null)).toBeNull();
  });
});

describe("parseTrendParams", () => {
  it("applies defaults and rejects a peer count above the peer list", () => {
    const p = parseTrendParams({});
    expect(p.atrLen).toBe(14);
    expect(p.expansionWindow).toBe(36);
    expect(() => parseTrendParams({ peerMinCount: 1 })).toThrow(/peerMinCount/);
    expect(() => parseTrendParams({ expansionMultiple: 9 })).toThrow(/expansionMultiple/);
  });

  it("trendBarsNeeded covers the slowest warmup", () => {
    expect(trendBarsNeeded(parseTrendParams({}))).toBe(80);
  });
});

describe("parseTrendStrategyInput", () => {
  const NOW = Date.parse("2026-10-20T12:00:00.000Z");
  const body = {
    mode: "live",
    runMode: "shadow",
    instId: "NVDA-USDT-SWAP",
    direction: "long",
    lever: 20,
    firstSz: "0.01",
    theme: "trend-probe",
    themeStopCapU: 0.1,
    expiresInDays: 1,
  };

  it("parses a valid create body", () => {
    const parsed = parseTrendStrategyInput(body, NOW);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.runMode).toBe("shadow");
      expect(parsed.value.mode).toBe("live");
      expect(parsed.value.params.atrLen).toBe(14);
      expect(parsed.value.expiresAt).toBe("2026-10-21T12:00:00.000Z");
    }
  });

  it("requires runMode to be explicit", () => {
    const { runMode: _dropped, ...without } = body;
    const parsed = parseTrendStrategyInput(without, NOW);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/runMode/);
  });

  it("requires mode to be explicit, so an instance cannot land in an account the evaluator never reads", () => {
    const { mode: _dropped, ...without } = body;
    const parsed = parseTrendStrategyInput(without, NOW);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/mode/);
  });

  it("rejects a theme cap above the platform maximum and self-peering", () => {
    expect(parseTrendStrategyInput({ ...body, themeStopCapU: 0.2 }, NOW).ok).toBe(false);
    const selfPeer = parseTrendStrategyInput(
      { ...body, params: { peerInstIds: ["NVDA-USDT-SWAP"], peerMinCount: 1 } },
      NOW,
    );
    expect(selfPeer.ok).toBe(false);
  });
});
