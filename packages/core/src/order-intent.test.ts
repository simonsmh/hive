import { describe, expect, it } from "vitest";
import {
  type OkxIntent,
  type RiskLimitsView,
  adjustMarginBody,
  algoOrderBody,
  clientOrderIds,
  isExpired,
  needsPriceGate,
  parseIntent,
  placeOrderBody,
  preflightRisk,
  priceRisk,
} from "./order-intent.js";

const NOW = Date.parse("2026-10-14T06:40:30.000Z");

const GROK_SHORT = {
  schema: "okx.intent.v1",
  intentId: "int-20261014-0001",
  idempotencyKey: "grok-xau-cpi-short-0001",
  action: "open",
  instId: "XAU-USDT-SWAP",
  side: "sell",
  posSide: "net",
  tdMode: "isolated",
  lever: 15,
  sz: "1",
  ordType: "market",
  px: null,
  reduceOnly: false,
  slTriggerPx: "4125",
  slOrdPx: "-1",
  tpTriggerPx: "4085",
  tpOrdPx: "-1",
  theme: "xau_cpi",
  themeStopCapU: 0.1,
  maxLossU: 0.1,
  reason: "short after hot CPI",
  source: "grok",
  createdAt: "2026-10-14T14:40:00+08:00",
  ttlSec: 120,
};

const LIMITS: RiskLimitsView = {
  maxNotionalUsdt: 500,
  maxLeverage: 20,
  maxOrdersPerMin: 5,
};

const CLEAR = { killEngaged: false, submissionsLastMinute: 0 };

function parsed(overrides: Record<string, unknown> = {}): OkxIntent {
  const result = parseIntent({ ...GROK_SHORT, ...overrides }, NOW);
  if (!result.ok) throw new Error(`expected a valid intent, got: ${result.error}`);
  return result.intent;
}

function invalid(overrides: Record<string, unknown>): string {
  const result = parseIntent({ ...GROK_SHORT, ...overrides }, NOW);
  if (result.ok) throw new Error("expected the intent to be rejected");
  return result.error;
}

describe("parseIntent", () => {
  it("accepts the locked Grok sample and keeps OKX numeric fields as strings", () => {
    const intent = parsed();
    expect(intent.action).toBe("open");
    expect(intent.sz).toBe("1");
    expect(intent.slTriggerPx).toBe("4125");
    expect(intent.createdAtMs).toBe(Date.parse("2026-10-14T14:40:00+08:00"));
    expect(intent.ttlSec).toBe(120);
  });

  it("defaults ordType to market and ttlSec to 120", () => {
    const { ordType, ttlSec, ...rest } = GROK_SHORT;
    void ordType;
    void ttlSec;
    const result = parseIntent(rest, NOW);
    expect(result.ok && result.intent.ordType).toBe("market");
    expect(result.ok && result.intent.ttlSec).toBe(120);
  });

  it("rejects unknown fields so a misspelt TP or SL field is never silently dropped", () => {
    expect(invalid({ tpTriggerPX: "4085" })).toMatch(/unknown field\(s\): tpTriggerPX/);
  });

  it("rejects an unknown schema and a non-object body", () => {
    expect(invalid({ schema: "okx.intent.v2" })).toMatch(/schema/);
    expect(parseIntent("open", NOW)).toEqual({ ok: false, error: "body must be a JSON object" });
  });

  it("rejects missing required fields", () => {
    for (const field of ["intentId", "idempotencyKey", "source", "instId"]) {
      expect(invalid({ [field]: "" })).toMatch(new RegExp(field));
    }
  });

  it("rejects instruments that are not USDT-margined swaps", () => {
    expect(invalid({ instId: "BTC-USD-SWAP" })).toMatch(/USDT-margined swap/);
    expect(invalid({ instId: "BTC-USDT" })).toMatch(/USDT-margined swap/);
  });

  it("rejects non-positive or malformed sizes and prices", () => {
    expect(invalid({ sz: "0" })).toMatch(/sz/);
    expect(invalid({ sz: "-1" })).toMatch(/sz/);
    expect(invalid({ sz: "1e-7" })).toMatch(/sz/);
    expect(invalid({ slTriggerPx: "abc" })).toMatch(/slTriggerPx/);
  });

  it("rejects a ttlSec outside 1..3600", () => {
    expect(invalid({ ttlSec: 0 })).toMatch(/ttlSec/);
    expect(invalid({ ttlSec: 3601 })).toMatch(/ttlSec/);
    expect(invalid({ ttlSec: 1.5 })).toMatch(/ttlSec/);
  });

  it("rejects a createdAt that is clearly in the future", () => {
    expect(invalid({ createdAt: "2026-10-14T16:00:00+08:00" })).toMatch(/future/);
  });

  it("rejects an open that is reduceOnly, and a close or reduce that is not", () => {
    expect(invalid({ reduceOnly: true })).toMatch(/open cannot be reduceOnly/);
    expect(invalid({ action: "close", reduceOnly: false, slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null })).toMatch(
      /reduceOnly=true/,
    );
    expect(parseIntent({ ...GROK_SHORT, action: "reduce", reduceOnly: true, slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null }, NOW).ok).toBe(true);
  });

  it("requires px for limit orders", () => {
    expect(invalid({ ordType: "limit", px: null })).toMatch(/px is required/);
    expect(parsed({ ordType: "limit", px: "4100" }).px).toBe("4100");
  });

  it("requires a trigger and its ordPx together", () => {
    expect(invalid({ slOrdPx: null })).toMatch(/set together/);
    expect(invalid({ tpOrdPx: null })).toMatch(/set together/);
  });

  it("requires a trigger on amend_tpsl and accepts -1 as a market ordPx", () => {
    expect(
      invalid({ action: "amend_tpsl", slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null, reduceOnly: true }),
    ).toMatch(/needs slTriggerPx or tpTriggerPx/);
    const amend = parsed({ action: "amend_tpsl", sz: "1", side: "buy", reduceOnly: true, tpTriggerPx: "4085", tpOrdPx: "-1" });
    expect(amend.slTriggerPx).toBe("4125");
    expect(amend.tpOrdPx).toBe("-1");
  });

  it("parses an open with no stop loss so the risk gate can reject it with a specific reason", () => {
    const intent = parsed({ slTriggerPx: null, slOrdPx: null });
    expect(preflightRisk(intent, LIMITS, CLEAR)).toBe("missing_stop_loss");
  });

  it("parses a set_leverage that names the position and carries only a lever", () => {
    const intent = parsed({
      action: "set_leverage",
      lever: 20,
      slTriggerPx: null,
      slOrdPx: null,
      tpTriggerPx: null,
      tpOrdPx: null,
      theme: null,
      themeStopCapU: null,
      maxLossU: null,
    });
    expect(intent.action).toBe("set_leverage");
    expect(intent.lever).toBe(20);
    expect(needsPriceGate(intent)).toBe(false);
  });

  it("rejects a set_leverage without a lever or with order-only fields", () => {
    const base = { action: "set_leverage", slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null };
    expect(invalid({ ...base, lever: null })).toMatch(/lever is required for set_leverage/);
    expect(invalid({ ...base, lever: 20, slTriggerPx: "4125", slOrdPx: "-1" })).toMatch(/does not accept sl\/tp/);
    expect(invalid({ ...base, lever: 20, px: "4100" })).toMatch(/does not accept px/);
    expect(invalid({ ...base, lever: 20, reduceOnly: true })).toMatch(/cannot be reduceOnly/);
  });

  it("parses an adjust_margin that names the position and carries a positive margin amount", () => {
    const intent = parsed({
      action: "adjust_margin",
      marginAmt: "25.5",
      lever: null,
      slTriggerPx: null,
      slOrdPx: null,
      tpTriggerPx: null,
      tpOrdPx: null,
      theme: null,
      themeStopCapU: null,
      maxLossU: null,
    });
    expect(intent.action).toBe("adjust_margin");
    expect(intent.marginAmt).toBe("25.5");
    expect(needsPriceGate(intent)).toBe(false);
    expect(adjustMarginBody(intent)).toEqual({ instId: "XAU-USDT-SWAP", posSide: "net", type: "add", amt: "25.5" });
  });

  it("rejects an adjust_margin without a usable marginAmt", () => {
    const base = { action: "adjust_margin", slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null };
    expect(invalid(base)).toMatch(/marginAmt is required for adjust_margin/);
    expect(invalid({ ...base, marginAmt: "0" })).toMatch(/marginAmt must be a positive decimal/);
    expect(invalid({ ...base, marginAmt: "-5" })).toMatch(/marginAmt must be a positive decimal/);
    expect(invalid({ ...base, marginAmt: "abc" })).toMatch(/marginAmt must be a positive decimal/);
  });

  it("rejects an adjust_margin that carries fields only an order could consume", () => {
    const base = { action: "adjust_margin", marginAmt: "10", lever: null, slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null };
    expect(invalid({ ...base, lever: 20 })).toMatch(/adjust_margin does not accept lever/);
    expect(invalid({ ...base, reduceOnly: true })).toMatch(/adjust_margin cannot be reduceOnly/);
    expect(invalid({ ...base, px: "4100" })).toMatch(/adjust_margin does not accept px/);
    expect(invalid({ ...base, slTriggerPx: "4125", slOrdPx: "-1" })).toMatch(/adjust_margin does not accept sl\/tp/);
    expect(invalid({ ...base, tdMode: "cross" })).toMatch(/adjust_margin only supports isolated positions/);
  });

  it("rejects marginAmt on actions other than adjust_margin", () => {
    expect(invalid({ action: "open", marginAmt: "10" })).toMatch(/marginAmt is only accepted for adjust_margin/);
    expect(invalid({ action: "close", reduceOnly: true, marginAmt: "10" })).toMatch(/marginAmt is only accepted for adjust_margin/);
    expect(invalid({ action: "set_leverage", lever: 20, slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null, marginAmt: "10" })).toMatch(/marginAmt is only accepted for adjust_margin/);
  });
});

describe("isExpired", () => {
  it("expires after createdAt + ttlSec and not before", () => {
    const intent = parsed({ createdAt: "2026-10-14T14:40:00+08:00", ttlSec: 120 });
    const created = Date.parse("2026-10-14T14:40:00+08:00");
    expect(isExpired(intent, created + 120_000)).toBe(false);
    expect(isExpired(intent, created + 120_001)).toBe(true);
  });
});

describe("clientOrderIds", () => {
  it("is deterministic per idempotency key and yields OKX-safe alphanumeric ids", () => {
    const a = clientOrderIds("key-a");
    expect(clientOrderIds("key-a")).toEqual(a);
    expect(clientOrderIds("key-b").clOrdId).not.toBe(a.clOrdId);
    for (const id of [a.clOrdId, a.attachAlgoClOrdId, a.algoClOrdId]) {
      expect(id).toMatch(/^[a-z0-9]{32}$/);
    }
    expect(new Set([a.clOrdId, a.attachAlgoClOrdId, a.algoClOrdId]).size).toBe(3);
  });
});

describe("preflightRisk", () => {
  it("passes the Grok sample when every gate is clear", () => {
    expect(preflightRisk(parsed(), LIMITS, CLEAR)).toBeNull();
  });

  it("rejects everything while the kill switch is engaged", () => {
    expect(preflightRisk(parsed(), LIMITS, { killEngaged: true, submissionsLastMinute: 0 })).toBe("kill_switch_engaged");
  });

  it("fails closed when no risk limits exist for the mode", () => {
    expect(preflightRisk(parsed(), null, CLEAR)).toBe("no_risk_limits");
  });

  it("does not gate on the instrument: opens, closes and reduces on any USDT swap pass when the other gates are clear", () => {
    const close = { action: "close", reduceOnly: true, instId: "QQQ-USDT-SWAP", slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null };
    const reduce = { action: "reduce", reduceOnly: true, instId: "QQQ-USDT-SWAP", slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null };
    expect(preflightRisk(parsed({ instId: "DOGE-USDT-SWAP" }), LIMITS, CLEAR)).toBeNull();
    expect(preflightRisk(parsed(close), LIMITS, CLEAR)).toBeNull();
    expect(preflightRisk(parsed(reduce), LIMITS, CLEAR)).toBeNull();
  });

  it("enforces the per-minute submission rate", () => {
    expect(preflightRisk(parsed(), LIMITS, { killEngaged: false, submissionsLastMinute: 5 })).toBe("rate_limited");
    expect(preflightRisk(parsed(), LIMITS, { killEngaged: false, submissionsLastMinute: 4 })).toBeNull();
  });

  it("rejects an open that lacks a lever, theme, stop loss or theme cap", () => {
    expect(preflightRisk(parsed({ lever: null }), LIMITS, CLEAR)).toBe("missing_lever");
    expect(preflightRisk(parsed({ theme: null }), LIMITS, CLEAR)).toBe("missing_theme");
    expect(preflightRisk(parsed({ slTriggerPx: null, slOrdPx: null }), LIMITS, CLEAR)).toBe("missing_stop_loss");
    expect(preflightRisk(parsed({ themeStopCapU: null }), LIMITS, CLEAR)).toBe("missing_theme_stop_cap");
  });

  it("rejects leverage above the cap", () => {
    expect(preflightRisk(parsed({ lever: 25 }), LIMITS, CLEAR)).toBe("leverage_exceeds_limit");
    expect(preflightRisk(parsed({ lever: 20 }), LIMITS, CLEAR)).toBeNull();
  });

  it("gates set_leverage on the lever alone: no theme, stop loss or cap is required", () => {
    const base = {
      action: "set_leverage",
      slTriggerPx: null,
      slOrdPx: null,
      tpTriggerPx: null,
      tpOrdPx: null,
      theme: null,
      themeStopCapU: null,
      maxLossU: null,
    };
    expect(preflightRisk(parsed({ ...base, lever: 20 }), LIMITS, CLEAR)).toBeNull();
    expect(preflightRisk(parsed({ ...base, lever: 21 }), LIMITS, CLEAR)).toBe("leverage_exceeds_limit");
    expect(preflightRisk({ ...parsed({ ...base, lever: 20 }), lever: null }, LIMITS, CLEAR)).toBe("missing_lever");
    expect(preflightRisk(parsed({ ...base, lever: 20 }), LIMITS, { killEngaged: true, submissionsLastMinute: 0 })).toBe(
      "kill_switch_engaged",
    );
  });

  it("gates adjust_margin on the risk-gate trio only: no notional, leverage or theme cap applies", () => {
    const base = {
      action: "adjust_margin",
      lever: null,
      marginAmt: "10",
      theme: null,
      themeStopCapU: null,
      maxLossU: null,
      slTriggerPx: null,
      slOrdPx: null,
      tpTriggerPx: null,
      tpOrdPx: null,
    };
    expect(preflightRisk(parsed(base), LIMITS, CLEAR)).toBeNull();
    expect(preflightRisk(parsed(base), LIMITS, { killEngaged: true, submissionsLastMinute: 0 })).toBe("kill_switch_engaged");
    expect(preflightRisk(parsed(base), null, CLEAR)).toBe("no_risk_limits");
    expect(preflightRisk(parsed(base), LIMITS, { killEngaged: false, submissionsLastMinute: 5 })).toBe("rate_limited");
  });
});

describe("priceRisk", () => {
  const ctx = { entryPx: 4107, ctVal: 0.001 };

  it("passes the Grok sample: one XAU contract with an 18-point stop loses about 0.018 USDT", () => {
    expect(priceRisk(parsed(), LIMITS, ctx)).toBeNull();
  });

  it("rejects a stop loss whose loss exceeds themeStopCapU", () => {
    expect(priceRisk(parsed({ themeStopCapU: 0.01 }), LIMITS, ctx)).toBe("loss_exceeds_theme_cap");
  });

  it("also enforces maxLossU when it is set", () => {
    expect(priceRisk(parsed({ themeStopCapU: 1, maxLossU: 0.01 }), LIMITS, ctx)).toBe("loss_exceeds_max_loss");
  });

  it("rejects a stop loss on the wrong side of entry", () => {
    expect(priceRisk(parsed({ slTriggerPx: "4100" }), LIMITS, ctx)).toBe("stop_loss_wrong_side");
    expect(priceRisk(parsed({ side: "buy", slTriggerPx: "4125" }), LIMITS, ctx)).toBe("stop_loss_wrong_side");
  });

  it("rejects an open whose notional exceeds maxNotionalUsdt", () => {
    expect(priceRisk(parsed({ sz: "200000" }), LIMITS, ctx)).toBe("notional_exceeds_limit");
  });

  it("fails closed when the entry price or contract value is missing", () => {
    expect(priceRisk(parsed(), LIMITS, { entryPx: 0, ctVal: 0.001 })).toBe("price_unavailable");
    expect(priceRisk(parsed(), LIMITS, { entryPx: 4107, ctVal: 0 })).toBe("price_unavailable");
  });

  it("applies the stop-loss side rule to amend_tpsl, where side is the closing order (buy closes a short)", () => {
    const amend = parsed({ action: "amend_tpsl", side: "buy", reduceOnly: true, tpTriggerPx: null, tpOrdPx: null, lever: null });
    expect(priceRisk(amend, LIMITS, { entryPx: 4107, ctVal: 0.001 })).toBeNull();
    expect(priceRisk({ ...amend, slTriggerPx: "4100" }, LIMITS, { entryPx: 4107, ctVal: 0.001 })).toBe("stop_loss_wrong_side");
  });

  it("is only needed for opens and for amends that carry a cap", () => {
    expect(needsPriceGate(parsed())).toBe(true);
    expect(needsPriceGate(parsed({ action: "amend_tpsl", reduceOnly: true, themeStopCapU: null, maxLossU: null }))).toBe(false);
    expect(needsPriceGate(parsed({ action: "amend_tpsl", reduceOnly: true, themeStopCapU: 0.1 }))).toBe(true);
  });
});

describe("placeOrderBody", () => {
  it("attaches the stop loss and take profit to an open and leaves posSide out in net mode", () => {
    const ids = clientOrderIds("grok-xau-cpi-short-0001");
    const body = placeOrderBody(parsed(), ids);
    expect(body).toEqual({
      instId: "XAU-USDT-SWAP",
      tdMode: "isolated",
      side: "sell",
      ordType: "market",
      sz: "1",
      clOrdId: ids.clOrdId,
      reduceOnly: false,
      attachAlgoOrds: [
        {
          attachAlgoClOrdId: ids.attachAlgoClOrdId,
          slTriggerPx: "4125",
          slOrdPx: "-1",
          slTriggerPxType: "last",
          tpTriggerPx: "4085",
          tpOrdPx: "-1",
          tpTriggerPxType: "last",
        },
      ],
    });
  });

  it("sends px for limit orders and posSide for long/short accounts", () => {
    const ids = clientOrderIds("k");
    const body = placeOrderBody(parsed({ ordType: "limit", px: "4100", posSide: "short" }), ids);
    expect(body.px).toBe("4100");
    expect(body.posSide).toBe("short");
  });

  it("sends a reduce-only order with no attached algo for close and reduce", () => {
    const ids = clientOrderIds("close-1");
    const body = placeOrderBody(
      parsed({ action: "close", reduceOnly: true, side: "buy", slTriggerPx: null, slOrdPx: null, tpTriggerPx: null, tpOrdPx: null }),
      ids,
    );
    expect(body.reduceOnly).toBe(true);
    expect(body.attachAlgoOrds).toBeUndefined();
  });
});

describe("algoOrderBody", () => {
  it("builds a reduce-only conditional order for a stop loss alone", () => {
    const intent = parsed({ action: "amend_tpsl", side: "buy", reduceOnly: true, tpTriggerPx: null, tpOrdPx: null });
    expect(algoOrderBody(intent, "a".repeat(32))).toEqual({
      instId: "XAU-USDT-SWAP",
      tdMode: "isolated",
      side: "buy",
      ordType: "conditional",
      sz: "1",
      reduceOnly: true,
      algoClOrdId: "a".repeat(32),
      slTriggerPx: "4125",
      slOrdPx: "-1",
      slTriggerPxType: "last",
    });
  });

  it("builds an OCO when both stop loss and take profit are set", () => {
    const intent = parsed({ action: "amend_tpsl", side: "buy", reduceOnly: true });
    const body = algoOrderBody(intent, "a".repeat(32));
    expect(body.ordType).toBe("oco");
    expect(body.tpTriggerPx).toBe("4085");
    expect(body.reduceOnly).toBe(true);
  });
});
