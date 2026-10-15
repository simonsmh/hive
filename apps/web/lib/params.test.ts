import { describe, expect, it } from "vitest";
import { ParamError } from "./api";
import {
  parseBooleanFlag,
  parseInteger,
  parseInterval,
  parseOneOf,
  parseOptionalSymbol,
  parseSearchTerm,
  parseSource,
  parseSymbol,
  parseSymbols,
  parseTimestamp,
  parseToken,
} from "./params";

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

describe("parseOptionalSymbol", () => {
  it("returns null when absent or blank and normalises otherwise", () => {
    expect(parseOptionalSymbol(null)).toBeNull();
    expect(parseOptionalSymbol("  ")).toBeNull();
    expect(parseOptionalSymbol("btc")).toBe("BTC");
    expect(() => parseOptionalSymbol("BT-C")).toThrow(ParamError);
  });
});

describe("parseOneOf", () => {
  it("returns null when absent and accepts members only", () => {
    expect(parseOneOf(null, "severity", ["info", "critical"] as const)).toBeNull();
    expect(parseOneOf("critical", "severity", ["info", "critical"] as const)).toBe("critical");
    expect(() => parseOneOf("urgent", "severity", ["info", "critical"] as const)).toThrow(/severity must be one of info, critical/);
  });
});

describe("parseBooleanFlag", () => {
  it("accepts only true and false", () => {
    expect(parseBooleanFlag(null, "unresolved")).toBeNull();
    expect(parseBooleanFlag("true", "unresolved")).toBe(true);
    expect(parseBooleanFlag("false", "unresolved")).toBe(false);
    expect(() => parseBooleanFlag("1", "unresolved")).toThrow(/true or false/);
  });
});

describe("parseToken", () => {
  it("matches the pattern or rejects", () => {
    expect(parseToken("price_cross", "kind", /^[a-z_]{1,64}$/, "[a-z_]{1,64}")).toBe("price_cross");
    expect(parseToken(null, "kind", /^[a-z_]{1,64}$/, "[a-z_]{1,64}")).toBeNull();
    expect(() => parseToken("Price-Cross", "kind", /^[a-z_]{1,64}$/, "[a-z_]{1,64}")).toThrow(ParamError);
  });
});

describe("parseSearchTerm", () => {
  it("trims, treats blank as absent and keeps non-ASCII text", () => {
    expect(parseSearchTerm(null, "q")).toBeNull();
    expect(parseSearchTerm("   ", "q")).toBeNull();
    expect(parseSearchTerm("  美联储 ", "q")).toBe("美联储");
  });

  it("rejects characters that would break the PostgREST filter and overlong terms", () => {
    for (const bad of ["a,b", "(x)", 'say "hi"', "back\\slash", "star*", "x".repeat(101)]) {
      expect(() => parseSearchTerm(bad, "q"), bad).toThrow(ParamError);
    }
  });
});
