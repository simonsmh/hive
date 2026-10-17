import { describe, expect, it } from "vitest";
import { DEFAULT_SYMBOLS, guessYahooSymbol, parseSymbolList, pickSwapInstId, rankUniverse, symbolForInstId } from "./symbols.js";
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

  it("polls ETH by default", () => {
    expect(parseSymbolList(undefined)).toContain("ETH");
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

describe("rankUniverse", () => {
  const tickers = [
    { instId: "SATS-USDT-SWAP", last: 0.0000004, volCcy24h: 39_000_000_000_000, change24h: 0.01, ts: 1 },
    { instId: "ETH-USDT-SWAP", last: 4000, volCcy24h: 700_000, change24h: 0.02, ts: 1 },
    { instId: "BTC-USDT-SWAP", last: 100_000, volCcy24h: 20_000, change24h: -0.01, ts: 1 },
    { instId: "SKHYNIX-USDT-SWAP", last: 200, volCcy24h: 200_000, change24h: null, ts: 1 },
    { instId: "DEAD-USDT-SWAP", last: 1, volCcy24h: 0, change24h: null, ts: 1 },
  ];

  it("ranks by turnover, not by base-unit volume", () => {
    const ranked = rankUniverse(tickers, new Map(), 10);
    expect(ranked.map((entry) => entry.instId)).toEqual([
      "ETH-USDT-SWAP",
      "BTC-USDT-SWAP",
      "SKHYNIX-USDT-SWAP",
      "SATS-USDT-SWAP",
    ]);
    expect(ranked[0]?.turnover).toBeCloseTo(2_800_000_000);
    expect(ranked[0]?.rank).toBe(1);
  });

  it("flags tracked instruments and resolves their stored symbol through aliases", () => {
    const ranked = rankUniverse(tickers, new Map([["SKHYNIX-USDT-SWAP", "SKHY"]]), 10);
    const skhy = ranked.find((entry) => entry.instId === "SKHYNIX-USDT-SWAP");
    expect(skhy?.tracked).toBe(true);
    expect(skhy?.symbol).toBe("SKHY");
    expect(ranked.find((entry) => entry.instId === "ETH-USDT-SWAP")?.tracked).toBe(false);
  });

  it("honours the limit", () => {
    expect(rankUniverse(tickers, new Map(), 2)).toHaveLength(2);
  });
});

describe("symbolForInstId / guessYahooSymbol", () => {
  it("maps the SKHYNIX alias back to SKHY only when SKHY is known", () => {
    expect(symbolForInstId("SKHYNIX-USDT-SWAP", new Set(["SKHY"]))).toBe("SKHY");
    expect(symbolForInstId("SKHYNIX-USDT-SWAP", new Set())).toBe("SKHYNIX");
    expect(symbolForInstId("SOL-USDT-SWAP", new Set(["SOL"]))).toBe("SOL");
  });

  it("guesses mechanical Yahoo mappings and skips what it cannot know", () => {
    expect(guessYahooSymbol("SOL")).toBe("SOL");
    expect(guessYahooSymbol("BZ")).toBe("BZ=F");
    expect(guessYahooSymbol("CL")).toBe("CL=F");
    expect(guessYahooSymbol("XAU")).toBeNull();
  });
});
