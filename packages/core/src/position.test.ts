import { describe, expect, it } from "vitest";
import {
  actionBucket,
  amendIntent,
  closingSide,
  decimalsOf,
  dynamicTakeProfit,
  formatToStep,
  halfReduceSize,
  halfWayFailed,
  halfWayLevel,
  managementKey,
  matchPosition,
  openIntent,
  parseSubscriptionUpsert,
  reduceIntent,
  roundToStep,
  selectProtection,
  tpBeyondMark,
  tpDeviationAtr,
  type PendingAlgo,
} from "./position.js";

const NOW = Date.parse("2026-10-14T06:40:30.000Z");

function algo(overrides: Partial<PendingAlgo>): PendingAlgo {
  return {
    algoId: "a1",
    algoClOrdId: "c1",
    side: "buy",
    posSide: "net",
    sz: 10,
    reduceOnly: true,
    slTriggerPx: "82700",
    slOrdPx: "-1",
    tpTriggerPx: "80400",
    tpOrdPx: "-1",
    ...overrides,
  };
}

describe("levels", () => {
  it("places the half-way level at the midpoint of entry and stop", () => {
    expect(halfWayLevel(81818.5, 82700)).toBe(82259.25);
    expect(halfWayLevel(731.19, 721)).toBeCloseTo(726.095, 10);
  });

  it("moves the take-profit from entry in the profit direction by atr x mult", () => {
    expect(dynamicTakeProfit("short", 81818.5, 1000, 0.8)).toBeCloseTo(81018.5, 6);
    expect(dynamicTakeProfit("long", 731.19, 2, 0.8)).toBeCloseTo(732.79, 6);
  });

  it("measures take-profit deviation in ATR units and treats a missing TP as unbounded", () => {
    expect(tpDeviationAtr(81000, 80400, 1000)).toBeCloseTo(0.6, 10);
    expect(tpDeviationAtr(81000, null, 1000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("rounds to the instrument tick and formats with the same precision", () => {
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.00000001)).toBe(8);
    expect(roundToStep(81018.46, 0.1)).toBe(81018.5);
    expect(roundToStep(731.186, 0.01)).toBe(731.19);
    expect(formatToStep(81018.5, 0.1)).toBe("81018.5");
    expect(formatToStep(3, 1)).toBe("3");
    expect(() => decimalsOf(0)).toThrow(RangeError);
  });
});

describe("half-way invalidation", () => {
  it("fires on a confirmed close beyond the midpoint on the adverse side only", () => {
    expect(halfWayFailed("short", 82259.25, 82300)).toBe(true);
    expect(halfWayFailed("short", 82259.25, 82259.25)).toBe(true);
    expect(halfWayFailed("short", 82259.25, 82200)).toBe(false);
    expect(halfWayFailed("long", 726.095, 725)).toBe(true);
    expect(halfWayFailed("long", 726.095, 727)).toBe(false);
  });

  it("sizes the reduce to half the position, floored to the lot", () => {
    expect(halfReduceSize(10, 1, 1, 0.5)).toBe("5");
    expect(halfReduceSize(7, 1, 1, 0.5)).toBe("3");
    expect(halfReduceSize(0.07, 0.01, 0.01, 0.5)).toBe("0.03");
  });

  it("returns null when half the position is below the minimum order size", () => {
    expect(halfReduceSize(1, 1, 1, 0.5)).toBeNull();
    expect(halfReduceSize(0.01, 0.01, 0.01, 0.5)).toBeNull();
  });
});

describe("take-profit safety", () => {
  it("requires the TP to be beyond the mark on the profit side", () => {
    expect(tpBeyondMark("short", 81000, 81500, 0.0005)).toBe(true);
    expect(tpBeyondMark("short", 81000, 80900, 0.0005)).toBe(false);
    expect(tpBeyondMark("long", 741, 735, 0.0005)).toBe(true);
    expect(tpBeyondMark("long", 741, 745, 0.0005)).toBe(false);
  });
});

describe("protection selection", () => {
  it("picks the largest reduce-only stop on the closing side", () => {
    const algos = [
      algo({ algoId: "small", sz: 2 }),
      algo({ algoId: "big", sz: 10 }),
      algo({ algoId: "opening", side: "sell" }),
      algo({ algoId: "no-sl", slTriggerPx: null }),
      algo({ algoId: "not-reduce", reduceOnly: false, sz: 99 }),
    ];
    expect(selectProtection(algos, "short", "net")?.algoId).toBe("big");
  });

  it("matches the position side in long/short mode", () => {
    const algos = [algo({ algoId: "long-side", side: "sell", posSide: "long" }), algo({ algoId: "short-side", side: "buy", posSide: "short" })];
    expect(selectProtection(algos, "long", "long")?.algoId).toBe("long-side");
    expect(selectProtection(algos, "long", "net")?.algoId).toBe("long-side");
    expect(selectProtection(algos, "short", "short")?.algoId).toBe("short-side");
  });

  it("returns null when no stop protects the position", () => {
    expect(selectProtection([algo({ side: "sell" })], "short", "net")).toBeNull();
  });

  it("maps the closing side for each direction", () => {
    expect(closingSide("short")).toBe("buy");
    expect(closingSide("long")).toBe("sell");
  });
});

describe("position matching", () => {
  const short = { posSide: "net" as const, direction: "short" as const };

  it("reads the signed net size and checks the direction", () => {
    expect(matchPosition([{ posSide: "net", pos: -12, avgPx: 81818.5, markPx: 81000 }], short)).toEqual({
      kind: "ok",
      size: 12,
      markPx: 81000,
    });
    expect(matchPosition([{ posSide: "net", pos: 12, avgPx: 81818.5, markPx: 81000 }], short)).toEqual({
      kind: "skip",
      reason: "direction_mismatch:long",
    });
  });

  it("reports no position when OKX has none", () => {
    expect(matchPosition([], short)).toEqual({ kind: "none" });
  });

  it("skips when the mark price is unusable", () => {
    expect(matchPosition([{ posSide: "net", pos: -1, avgPx: 1, markPx: Number.NaN }], short)).toEqual({
      kind: "skip",
      reason: "mark_price_unavailable",
    });
  });

  it("matches the named side in long/short mode", () => {
    const rows = [
      { posSide: "long", pos: 3, avgPx: 1, markPx: 2 },
      { posSide: "short", pos: 5, avgPx: 1, markPx: 2 },
    ];
    expect(matchPosition(rows, { posSide: "short", direction: "short" })).toEqual({ kind: "ok", size: 5, markPx: 2 });
  });
});

describe("idempotency", () => {
  it("buckets time by three minutes and keys are stable for the same inputs", () => {
    const aligned = Math.floor(NOW / 180_000) * 180_000;
    expect(actionBucket(NOW)).toBe(Math.floor(NOW / 180_000));
    expect(actionBucket(aligned + 179_999)).toBe(actionBucket(aligned));
    expect(actionBucket(aligned + 180_000)).toBe(actionBucket(aligned) + 1);
    const key = managementKey(["amend_tpsl", "BTC-USDT-SWAP", "81018.5", actionBucket(NOW)]);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(managementKey(["amend_tpsl", "BTC-USDT-SWAP", "81018.5", actionBucket(NOW)])).toBe(key);
    expect(managementKey(["amend_tpsl", "BTC-USDT-SWAP", "81018.6", actionBucket(NOW)])).not.toBe(key);
  });
});

describe("intent builders", () => {
  const base = {
    intentId: "pm-1",
    idempotencyKey: "pm-key",
    createdAt: "2026-10-14T06:40:30.000Z",
    source: "hive:position-manager",
    instId: "BTC-USDT-SWAP",
    direction: "short" as const,
    posSide: "net" as const,
    tdMode: "isolated" as const,
    sz: "12",
    reason: "test",
    ttlSec: 120,
  };

  it("builds an amend_tpsl intent that re-sends the stop and reduce-only closing side", () => {
    const intent = amendIntent({ ...base, slTriggerPx: "82700", slOrdPx: "-1", tpTriggerPx: "81018.5", tpOrdPx: "-1" });
    expect(intent).toMatchObject({
      schema: "okx.intent.v1",
      action: "amend_tpsl",
      side: "buy",
      reduceOnly: true,
      ordType: "market",
      slTriggerPx: "82700",
      slOrdPx: "-1",
      tpTriggerPx: "81018.5",
      tpOrdPx: "-1",
      source: "hive:position-manager",
    });
  });

  it("omits the TP fields when the TP is not being sent", () => {
    const intent = amendIntent({ ...base, slTriggerPx: "82700", slOrdPx: "-1", tpTriggerPx: null, tpOrdPx: null });
    expect(intent).not.toHaveProperty("tpTriggerPx");
    expect(intent).not.toHaveProperty("tpOrdPx");
  });

  it("builds a reduce intent on the closing side", () => {
    expect(reduceIntent({ ...base, sz: "6" })).toMatchObject({
      action: "reduce",
      side: "buy",
      sz: "6",
      reduceOnly: true,
      ordType: "market",
    });
    expect(reduceIntent({ ...base, direction: "long", sz: "3" })).toMatchObject({ side: "sell" });
  });

  it("builds an open intent with the stop attached and an optional TP", () => {
    const open = openIntent({
      intentId: "co-1",
      idempotencyKey: "co-key",
      createdAt: "2026-10-18T00:00:00.000Z",
      source: "hive:strategy-evaluator",
      instId: "NVDA-USDT-SWAP",
      direction: "long",
      posSide: "net",
      tdMode: "isolated",
      lever: 3,
      sz: "0.01",
      slTriggerPx: "206.12",
      tpTriggerPx: "241.33",
      theme: "reversal-oct",
      themeStopCapU: 0.1,
      reason: "reversal_long fired",
      ttlSec: 120,
    });
    expect(open).toMatchObject({
      schema: "okx.intent.v1",
      action: "open",
      side: "buy",
      reduceOnly: false,
      ordType: "market",
      lever: 3,
      slTriggerPx: "206.12",
      slOrdPx: "-1",
      tpTriggerPx: "241.33",
      tpOrdPx: "-1",
      theme: "reversal-oct",
      themeStopCapU: 0.1,
    });
    const noTp = openIntent({
      intentId: "co-2",
      idempotencyKey: "co-key-2",
      createdAt: "2026-10-18T00:00:00.000Z",
      source: "hive:strategy-evaluator",
      instId: "NVDA-USDT-SWAP",
      direction: "long",
      posSide: "net",
      tdMode: "isolated",
      lever: 3,
      sz: "0.01",
      slTriggerPx: "206.12",
      tpTriggerPx: null,
      theme: "reversal-oct",
      themeStopCapU: 0.1,
      reason: "reversal_long fired",
      ttlSec: 120,
    });
    expect(noTp).not.toHaveProperty("tpTriggerPx");
  });
});

describe("parseSubscriptionUpsert", () => {
  const btc = {
    mode: "live",
    instId: "BTC-USDT-SWAP",
    posSide: "net",
    direction: "short",
    lever: 15,
    tdMode: "isolated",
    entryPx: 81818.5,
    slPx: 82700,
    tpPx: 80400,
    midPx: 82259.25,
    themeStopCapU: 0.1,
  };

  it("accepts the BTC short seed with the documented defaults", () => {
    const result = parseSubscriptionUpsert(btc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      mode: "live",
      instId: "BTC-USDT-SWAP",
      direction: "short",
      midPx: 82259.25,
      atrLen: 14,
      atrMult: 0.8,
      amendMinAtrFrac: 0.15,
      halfReduceFrac: 0.5,
      dynamicTpEnabled: true,
      halfReduceEnabled: true,
      enabled: true,
      resetState: false,
    });
  });

  it("accepts the QQQ long seed without any symbol allowlist", () => {
    const result = parseSubscriptionUpsert({
      ...btc,
      instId: "QQQ-USDT-SWAP",
      posSide: "net",
      direction: "long",
      entryPx: 731.19,
      slPx: 721,
      tpPx: 741,
      midPx: 726.095,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts any USDT swap instrument", () => {
    expect(parseSubscriptionUpsert({ ...btc, instId: "DOGE-USDT-SWAP" }).ok).toBe(true);
  });

  it("derives the midpoint when it is omitted", () => {
    const result = parseSubscriptionUpsert({ ...btc, midPx: undefined });
    expect(result.ok && result.value.midPx).toBe(82259.25);
  });

  it("rejects a theme stop cap above 0.1 or not positive", () => {
    expect(parseSubscriptionUpsert({ ...btc, themeStopCapU: 0.2 }).ok).toBe(false);
    expect(parseSubscriptionUpsert({ ...btc, themeStopCapU: 0 }).ok).toBe(false);
  });

  it("rejects a geometry that does not match the side", () => {
    expect(parseSubscriptionUpsert({ ...btc, direction: "long", posSide: "long" }).ok).toBe(false);
    expect(parseSubscriptionUpsert({ ...btc, tpPx: 83000 }).ok).toBe(false);
    expect(parseSubscriptionUpsert({ ...btc, slPx: 81000 }).ok).toBe(false);
  });

  it("rejects a midpoint outside entry and stop", () => {
    expect(parseSubscriptionUpsert({ ...btc, midPx: 83000 }).ok).toBe(false);
  });

  it("rejects a posSide that contradicts the direction and a non-swap instId", () => {
    expect(parseSubscriptionUpsert({ ...btc, posSide: "long" }).ok).toBe(false);
    expect(parseSubscriptionUpsert({ ...btc, instId: "BTC-USD" }).ok).toBe(false);
  });

  it("rejects unknown modes and non-object bodies", () => {
    expect(parseSubscriptionUpsert({ ...btc, mode: "paper" }).ok).toBe(false);
    expect(parseSubscriptionUpsert([btc]).ok).toBe(false);
  });
});
