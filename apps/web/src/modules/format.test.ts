import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatBeijingTime,
  formatCredibility,
  formatPrice,
  formatSignedPercent,
  formatUtcDate,
} from "./format";

describe("formatBeijingTime", () => {
  it("renders UTC instants in Asia/Shanghai with a 24-hour clock", () => {
    expect(formatBeijingTime("2026-10-13T12:05:09.000Z")).toBe("2026/10/13 20:05:09");
  });

  it("returns a dash for missing or unparseable values", () => {
    expect(formatBeijingTime(null)).toBe("—");
    expect(formatBeijingTime(undefined)).toBe("—");
    expect(formatBeijingTime("not a date")).toBe("—");
  });
});

describe("formatUtcDate", () => {
  it("labels daily bars by their UTC date", () => {
    expect(formatUtcDate(Date.UTC(2026, 9, 13))).toBe("2026-10-13");
  });
});

describe("formatAge", () => {
  it.each([
    [null, "从未成功"],
    [0.4, "不到 1 分钟前"],
    [2.6, "3 分钟前"],
    [90, "1.5 小时前"],
    [60 * 49, "2 天前"],
  ])("formats %s minutes as %s", (minutes, expected) => {
    expect(formatAge(minutes)).toBe(expected);
  });
});

describe("formatPrice", () => {
  it("uses precision that suits the magnitude of the price", () => {
    expect(formatPrice(84_512.3456)).toBe("84,512.35");
    expect(formatPrice(192.0184)).toBe("192.02");
    expect(formatPrice(12.345678)).toBe("12.3457");
    expect(formatPrice(0.123456789)).toBe("0.123457");
  });
});

describe("formatSignedPercent / formatCredibility", () => {
  it("prefixes positive changes with a plus sign", () => {
    expect(formatSignedPercent(1.234)).toBe("+1.23%");
    expect(formatSignedPercent(-0.5)).toBe("-0.50%");
    expect(formatSignedPercent(0)).toBe("0.00%");
  });

  it("formats credibility as a rounded percentage or a dash", () => {
    expect(formatCredibility(0.875)).toBe("88%");
    expect(formatCredibility(null)).toBe("—");
  });
});
