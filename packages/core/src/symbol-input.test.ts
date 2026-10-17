import { describe, expect, it } from "vitest";
import { parseSymbolAddInput, parseSymbolListInput, SymbolInputError } from "./symbol-input.js";

describe("parseSymbolAddInput", () => {
  it("accepts a batch of bare symbols and normalises case", () => {
    expect(parseSymbolAddInput({ symbols: [{ symbol: "sol" }, { symbol: "ZEC" }] })).toEqual([
      { symbol: "SOL", okx_inst_id: null, yahoo_symbol: null, ths_code: null, ths_kind: null },
      { symbol: "ZEC", okx_inst_id: null, yahoo_symbol: null, ths_code: null, ths_kind: null },
    ]);
  });

  it("accepts a single-symbol object as a one-item batch", () => {
    expect(parseSymbolAddInput({ symbol: "SOL", okx_inst_id: "SOL-USDT-SWAP" })).toEqual([
      { symbol: "SOL", okx_inst_id: "SOL-USDT-SWAP", yahoo_symbol: null, ths_code: null, ths_kind: null },
    ]);
  });

  it("keeps explicit mappings and defaults ths_kind to stock when a ths_code is given", () => {
    expect(
      parseSymbolAddInput({ symbols: [{ symbol: "MOUTAI", ths_code: "600519.SH", yahoo_symbol: null }] }),
    ).toEqual([
      { symbol: "MOUTAI", okx_inst_id: null, yahoo_symbol: null, ths_code: "600519.SH", ths_kind: "stock" },
    ]);
  });

  it("collects problems instead of failing on the first one", () => {
    try {
      parseSymbolAddInput({ symbols: [{ symbol: "bad symbol!" }, { symbol: "OK1", ths_code: "600519" }] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SymbolInputError);
      expect((error as SymbolInputError).problems).toHaveLength(2);
    }
  });

  it("rejects duplicates inside one batch, bad instIds and empty bodies", () => {
    expect(() => parseSymbolAddInput({ symbols: [{ symbol: "SOL" }, { symbol: "sol" }] })).toThrow(SymbolInputError);
    expect(() => parseSymbolAddInput({ symbols: [{ symbol: "SOL", okx_inst_id: "SOL-PERP" }] })).toThrow(
      SymbolInputError,
    );
    expect(() => parseSymbolAddInput({ symbols: [] })).toThrow(SymbolInputError);
    expect(() => parseSymbolAddInput(null)).toThrow(SymbolInputError);
  });
});

describe("parseSymbolListInput", () => {
  it("normalises and de-duplicates", () => {
    expect(parseSymbolListInput({ symbols: ["btc", " BTC ", "eth"] })).toEqual(["BTC", "ETH"]);
  });

  it("rejects non-arrays and invalid entries", () => {
    expect(() => parseSymbolListInput({ symbols: "BTC" })).toThrow(SymbolInputError);
    expect(() => parseSymbolListInput({ symbols: ["BTC", "../x"] })).toThrow(SymbolInputError);
  });
});
