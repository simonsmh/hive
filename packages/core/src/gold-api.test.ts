import { describe, expect, it } from "vitest";
import { GoldApiError, parseGoldApiSpotUsd } from "./gold-api.js";

const NOW = Date.parse("2026-11-18T13:23:30Z");

const valid = {
  currency: "USD",
  currencySymbol: "$",
  exchangeRate: 1,
  name: "Gold",
  price: 3769.120117,
  symbol: "XAU",
  updatedAt: "2026-11-18T13:23:30Z",
  updatedAtReadable: "a few seconds ago",
};

describe("parseGoldApiSpotUsd", () => {
  it("accepts a documented USD spot payload and uses updatedAt as the quote time", () => {
    const quote = parseGoldApiSpotUsd(valid, { nowMs: NOW });
    expect(quote).toEqual({
      price: 3769.120117,
      ts: NOW,
      currency: "USD",
      symbol: "XAU",
      name: "Gold",
    });
    expect(quote.price).toBeGreaterThan(3720);
  });

  it("rejects a non-USD currency so a converted quote is not treated as XAUUSD", () => {
    expect(() => parseGoldApiSpotUsd({ ...valid, currency: "EUR" }, { nowMs: NOW })).toThrow(GoldApiError);
  });

  it("rejects a missing or unparsable updatedAt rather than substituting the wall clock", () => {
    expect(() => parseGoldApiSpotUsd({ ...valid, updatedAt: undefined }, { nowMs: NOW })).toThrow(/updatedAt/);
    expect(() => parseGoldApiSpotUsd({ ...valid, updatedAt: "soon" }, { nowMs: NOW })).toThrow(/updatedAt/);
  });

  it("rejects a stale updatedAt", () => {
    expect(() =>
      parseGoldApiSpotUsd({ ...valid, updatedAt: "2026-11-18T13:00:00Z" }, { nowMs: NOW, maxAgeMs: 8 * 60_000 }),
    ).toThrow(/stale/);
  });

  it("is a fixture payload, not a live market print, when price is obviously synthetic", () => {
    const fixture = parseGoldApiSpotUsd({ ...valid, price: 1 }, { nowMs: NOW });
    expect(fixture.price).toBe(1);
  });
});
