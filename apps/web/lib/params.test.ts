import { describe, expect, it } from "vitest";
import { ParamError } from "./api";
import { parseInteger, parseInterval, parseSource, parseSymbol, parseSymbols, parseTimestamp } from "./params";

describe("parseSource", () => {
  it("defaults to okx and accepts the enum members", () => {
    expect(parseSource(null)).toBe("okx");
    expect(parseSource("yahoo")).toBe("yahoo");
  });

  it("rejects unknown sources", () => {
    expect(() => parseSource("binance")).toThrow(ParamError);
  });
});

describe("parseInterval", () => {
  it("requires a supported interval", () => {
    expect(parseInterval("5m")).toBe("5m");
    expect(() => parseInterval(null)).toThrow(/required/);
    expect(() => parseInterval("2m")).toThrow(/interval must be one of/);
  });
});

describe("parseSymbol / parseSymbols", () => {
  it("normalises symbols and removes duplicates", () => {
    expect(parseSymbols(" nvda, BTC ,nvda")).toEqual(["NVDA", "BTC"]);
    expect(parseSymbol("xau")).toBe("XAU");
  });

  it("rejects empty, malformed and oversized lists", () => {
    expect(() => parseSymbols(null)).toThrow(/symbols is required/);
    expect(() => parseSymbols(" , ")).toThrow(/symbols is required/);
    expect(() => parseSymbols("NVDA;DROP")).toThrow(/invalid symbol/);
    const many = Array.from({ length: 51 }, (_, i) => `S${i}`).join(",");
    expect(() => parseSymbols(many)).toThrow(/at most 50/);
    expect(() => parseSymbol("../x")).toThrow(ParamError);
  });
});

describe("parseInteger", () => {
  it("returns the fallback when absent and enforces bounds", () => {
    expect(parseInteger(null, "period", 14, 1, 100)).toBe(14);
    expect(parseInteger("20", "period", 14, 1, 100)).toBe(20);
    expect(() => parseInteger("0", "period", 14, 1, 100)).toThrow(/between 1 and 100/);
    expect(() => parseInteger("1.5", "period", 14, 1, 100)).toThrow(/integer/);
  });
});

describe("parseTimestamp", () => {
  it("accepts epoch milliseconds and ISO strings, returning ISO", () => {
    expect(parseTimestamp("1700000000000", "from")).toBe("2023-11-14T22:13:20.000Z");
    expect(parseTimestamp("2024-01-02T03:04:05Z", "from")).toBe("2024-01-02T03:04:05.000Z");
    expect(parseTimestamp(null, "from")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(() => parseTimestamp("yesterday", "to")).toThrow(/to must be/);
  });
});
