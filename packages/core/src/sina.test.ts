import { describe, expect, it } from "vitest";
import {
  barConfirmed,
  parseSinaKLine,
  SinaParseError,
  toSinaCode,
} from "./sina.js";

/** 2026-10-30 10:00 Beijing = 2026-10-30 02:00 UTC, before the close. */
const BEFORE_CLOSE = Date.parse("2026-10-30T02:00:00Z");
/** 2026-10-30 16:00 Beijing = 2026-10-30 08:00 UTC, after the close. */
const AFTER_CLOSE = Date.parse("2026-10-30T08:00:00Z");

function klineBody(rows: string): string {
  return `/*<script>location.href='//sina.com';</script>*/\nvar _600487=([${rows}]);`;
}

const TWO_ROWS = [
  `{"day":"2026-10-29","open":"47.660","high":"47.950","low":"44.550","close":"44.600","volume":"136767393"}`,
  `{"day":"2026-10-30","open":"42.350","high":"45.210","low":"42.260","close":"42.420","volume":"125791912"}`,
].join(",");

describe("toSinaCode", () => {
  it("maps SH/SZ/BJ ths_code to the lowercase Sina prefix with unchanged digits", () => {
    expect(toSinaCode("600487.SH")).toBe("sh600487");
    expect(toSinaCode("001309.SZ")).toBe("sz001309");
    expect(toSinaCode("000001.SH")).toBe("sh000001");
    expect(toSinaCode("399001.SZ")).toBe("sz399001");
    expect(toSinaCode("588170.SH")).toBe("sh588170");
    expect(toSinaCode("513310.SH")).toBe("sh513310");
    expect(toSinaCode("430001.BJ")).toBe("bj430001");
  });

  it("returns null for missing, malformed and unknown-suffix codes instead of guessing", () => {
    expect(toSinaCode(null)).toBeNull();
    expect(toSinaCode("600487")).toBeNull();
    expect(toSinaCode("60048.SH")).toBeNull();
    expect(toSinaCode("600487.TI")).toBeNull();
    expect(toSinaCode("600487.sh")).toBeNull();
  });
});

describe("barConfirmed", () => {
  it("confirms bars dated before today in Beijing", () => {
    expect(barConfirmed("2026-10-29", BEFORE_CLOSE)).toBe(true);
    expect(barConfirmed("2026-10-29", AFTER_CLOSE)).toBe(true);
  });

  it("leaves today's bar unconfirmed before the 15:00 close and confirms it after", () => {
    expect(barConfirmed("2026-10-30", BEFORE_CLOSE)).toBe(false);
    expect(barConfirmed("2026-10-30", AFTER_CLOSE)).toBe(true);
  });

  it("never confirms a bar dated after today", () => {
    expect(barConfirmed("2026-10-31", AFTER_CLOSE)).toBe(false);
  });
});

describe("parseSinaKLine", () => {
  it("parses the real 2026-10-30 Hengtong rows and keys bars by 00:00 UTC of the Beijing date", () => {
    const parsed = parseSinaKLine(klineBody(TWO_ROWS), { nowMs: AFTER_CLOSE });
    expect(parsed.rejected).toBe(0);
    expect(parsed.candles).toEqual([
      {
        ts: Date.UTC(2026, 9, 29),
        open: 47.66,
        high: 47.95,
        low: 44.55,
        close: 44.6,
        volume: 136767393,
        volCcy: 0,
        confirmed: true,
      },
      {
        ts: Date.UTC(2026, 9, 30),
        open: 42.35,
        high: 45.21,
        low: 42.26,
        close: 42.42,
        volume: 125791912,
        volCcy: 0,
        confirmed: true,
      },
    ]);
  });

  it("marks today's bar unconfirmed when fetched before the close", () => {
    const parsed = parseSinaKLine(klineBody(TWO_ROWS), { nowMs: BEFORE_CLOSE });
    expect(parsed.candles[1]?.confirmed).toBe(false);
    expect(parsed.candles[0]?.confirmed).toBe(true);
  });

  it("counts malformed rows as rejected instead of aborting the response", () => {
    const parsed = parseSinaKLine(
      klineBody(
        [
          `{"day":"2026-10-29","open":"47.660","high":"47.950","low":"44.550","close":"44.600","volume":"136767393"}`,
          `{"day":"2026-10-30","open":"42.350","high":"42.260","low":"45.210","close":"42.420","volume":"125791912"}`,
          `{"day":"bad","open":"1","high":"2","low":"0.5","close":"1.5","volume":"10"}`,
        ].join(","),
      ),
      { nowMs: AFTER_CLOSE },
    );
    expect(parsed.rejected).toBe(2);
    expect(parsed.candles).toHaveLength(1);
  });

  it("throws on a body with no JSON array", () => {
    expect(() => parseSinaKLine("/*<script>location.href='//sina.com';</script>*/", { nowMs: AFTER_CLOSE })).toThrow(
      SinaParseError,
    );
  });
});
