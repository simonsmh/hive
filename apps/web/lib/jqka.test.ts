import { describe, expect, it } from "vitest";
import {
  fetchDepthQuote,
  JQKA_SOURCE,
  parseAshareCodes,
  parseJsonp,
  parseMinute,
  parseRealhead,
  toJqkaSymbol,
} from "./jqka";

// Real payload shape from 2026-10-29 14:18:29 (513310), trimmed to the
// fields the parser reads; unrelated fields are intentionally omitted.
const REALHEAD = `quotebridge_v2_realhead_hs_513310_last({"items":{"10":"3.838","6":"3.908","7":"3.845","8":"3.917","9":"3.784","13":"3442825400.000","19":"13221547100.000","time":"2026-10-29 14:18:29 北京时间","name":"中韩半导体ETF华泰柏瑞"}})`;

const MINUTE = `quotebridge_v2_time_hs_513310_last({"hs_513310":{"date":"20261029","pre":"3.908","data":"0930,3.845,62372821,3.845,16221800;0931,3.814,163290240,3.834,42643300;badrow;0932,3.816,122648520,3.828,32132201"}})`;

describe("jqka source naming", () => {
  it("is jqka, not the paid ths-collector source", () => {
    expect(JQKA_SOURCE).toBe("jqka");
    expect(JQKA_SOURCE).not.toBe("ths");
  });
});

describe("parseAshareCodes", () => {
  it("accepts 6-digit codes and dedupes", () => {
    expect(parseAshareCodes("513310,600487,513310")).toEqual(["513310", "600487"]);
  });
  it("rejects non-6-digit and non-numeric input", () => {
    expect(() => parseAshareCodes("51331")).toThrow();
    expect(() => parseAshareCodes("513310;600487")).toThrow();
    expect(() => parseAshareCodes("AAPL")).toThrow();
    expect(() => parseAshareCodes("")).toThrow();
    expect(() => parseAshareCodes(null)).toThrow();
  });
  it("rejects more than 50 codes", () => {
    const many = Array.from({ length: 51 }, (_, i) => String(600000 + i)).join(",");
    expect(() => parseAshareCodes(many)).toThrow(/at most 50/);
  });
  it("maps codes to hs_ symbols", () => {
    expect(toJqkaSymbol("513310")).toBe("hs_513310");
    expect(toJqkaSymbol("600487")).toBe("hs_600487");
  });
});

describe("parseJsonp", () => {
  it("strips the JSONP wrapper", () => {
    expect(parseJsonp(REALHEAD)).toMatchObject({ items: { "10": "3.838" } });
  });
  it("rejects HTML error pages and empty bodies instead of echoing them", () => {
    expect(() => parseJsonp("<html><title>502 Bad Gateway</title></html>")).toThrow();
    expect(() => parseJsonp("")).toThrow();
    expect(() => parseJsonp("not json")).toThrow();
  });
});

describe("parseRealhead", () => {
  it("maps verified fields and computes change vs prev close", () => {
    const quote = parseRealhead("513310", parseJsonp(REALHEAD));
    expect(quote.symbol).toBe("513310");
    expect(quote.name).toBe("中韩半导体ETF华泰柏瑞");
    expect(quote.last).toBe(3.838);
    expect(quote.prev_close).toBe(3.908);
    expect(quote.open).toBe(3.845);
    expect(quote.high).toBe(3.917);
    expect(quote.low).toBe(3.784);
    expect(quote.volume).toBe(3442825400);
    expect(quote.turnover).toBe(13221547100);
    expect(quote.change_pct).toBeCloseTo(((3.838 - 3.908) / 3.908) * 100, 10);
    expect(quote.ts).toContain("2026-10-29 14:18:29");
    // Five-level book is unverified: never guessed.
    expect(quote.bid).toEqual([]);
    expect(quote.ask).toEqual([]);
  });
  it("rejects payloads missing a verified field", () => {
    expect(() => parseRealhead("513310", { items: { "10": "3.838" } })).toThrow();
  });
  it("rejects empty or whitespace numeric fields instead of parsing them as 0", () => {
    const base = { "10": "3.838", "6": "3.908", "7": "3.845", "8": "3.917", "9": "3.784", "13": "100", "19": "100", time: "2026-10-29 14:18:29", name: "x" };
    expect(() => parseRealhead("513310", { items: { ...base, "10": "" } })).toThrow();
    expect(() => parseRealhead("513310", { items: { ...base, "6": " " } })).toThrow();
  });
});

describe("parseMinute", () => {
  it("parses time/price/volume and skips malformed rows", () => {
    const { date, points } = parseMinute("513310", parseJsonp(MINUTE));
    expect(date).toBe("20261029");
    expect(points).toEqual([
      { time: "09:30", price: 3.845, volume: 16221800 },
      { time: "09:31", price: 3.814, volume: 42643300 },
      { time: "09:32", price: 3.816, volume: 32132201 },
    ]);
  });
});

describe("fetchDepthQuote error mapping", () => {
  it("maps an upstream 502 HTML body to a generic error, not the raw body", async () => {
    const stub = async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    const result = await fetchDepthQuote("513310", { fetchFn: stub as never });
    expect(result.quote).toBeNull();
    expect(result.error).toBe("upstream unavailable");
  });
  it("returns a quote with minute data when requested", async () => {
    const stub = async (url: string) => {
      if (url.includes("/realhead/")) return new Response(REALHEAD, { status: 200 });
      if (url.includes("/time/")) return new Response(MINUTE, { status: 200 });
      throw new Error(`unexpected url ${url}`);
    };
    const result = await fetchDepthQuote("513310", { includeMinute: true, fetchFn: stub as never });
    expect(result.error).toBeNull();
    expect(result.quote?.minute).toHaveLength(3);
    expect(result.quote?.minute_date).toBe("20261029");
  });
  it("omits minute data by default", async () => {
    const stub = async () => new Response(REALHEAD, { status: 200 });
    const result = await fetchDepthQuote("513310", { fetchFn: stub as never });
    expect(result.quote?.minute).toBeUndefined();
  });
});
