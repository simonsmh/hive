import { describe, expect, it } from "vitest";
import { DEFAULT_SYMBOLS, parseSymbolList, pickSwapInstId } from "./symbols.js";
import type { OkxInstrument } from "./okx.js";

const instruments: OkxInstrument[] = [
  { instId: "BTC-USD-SWAP", instType: "SWAP", state: "live" },
  { instId: "BTC-USDT-SWAP", instType: "SWAP", state: "live" },
  { instId: "XAU-USDT-SWAP", instType: "SWAP", state: "live" },
  { instId: "OLD-USDT-SWAP", instType: "SWAP", state: "suspend" },
  { instId: "EUR-USD-SWAP", instType: "SWAP", state: "live" },
];

describe("parseSymbolList", () => {
  it("defaults to the Hive symbol list", () => {
    expect(parseSymbolList(undefined)).toEqual([...DEFAULT_SYMBOLS]);
    expect(parseSymbolList("  ")).toEqual([...DEFAULT_SYMBOLS]);
  });

  it("normalises case, trims and de-duplicates", () => {
    expect(parseSymbolList(" nvda, NVDA ,btc")).toEqual(["NVDA", "BTC"]);
  });

  it("rejects invalid symbols", () => {
    expect(() => parseSymbolList("NVDA,../etc")).toThrow(/invalid symbol/);
  });
});

describe("pickSwapInstId", () => {
  it("prefers the USDT perpetual", () => {
    expect(pickSwapInstId("BTC", instruments)).toBe("BTC-USDT-SWAP");
  });

  it("falls back to a USD swap when no USDT contract is live", () => {
    expect(pickSwapInstId("EUR", instruments)).toBe("EUR-USD-SWAP");
  });

  it("ignores non-live instruments and returns null when none match", () => {
    expect(pickSwapInstId("OLD", instruments)).toBeNull();
    expect(pickSwapInstId("MU", instruments)).toBeNull();
  });
});
