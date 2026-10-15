import { describe, expect, it } from "vitest";
import { digestHealth, digestNewest, digestQuotes } from "./digest";

describe("stream digests", () => {
  it("are stable for unchanged input and move when content moves", () => {
    const quotes = [
      { symbol: "MU", price: 100, ts: "2026-10-16T00:00:00Z" },
      { symbol: "BTC", price: "200", ts: "2026-10-16T00:00:00Z" },
    ];
    expect(digestQuotes(quotes)).toBe(digestQuotes([...quotes]));
    expect(digestQuotes(quotes)).not.toBe(digestQuotes([{ ...quotes[0]!, price: 101 }, quotes[1]!]));

    expect(digestNewest(["a", "b"], 2)).toBe(digestNewest(["a", "b"], 2));
    expect(digestNewest(["a", "b"], 2)).not.toBe(digestNewest(["c", "a"], 2));
    expect(digestNewest(["a"], 1)).not.toBe(digestNewest(["a"], 2));
  });

  it("health digest reacts to success timestamps and failure counts", () => {
    const rows = [
      { source: "okx", enabled: true, last_success_at: "2026-10-16T00:00:00Z", consecutive_failures: 0, max_staleness_minutes: 5, last_error: null },
    ];
    expect(digestHealth(rows)).toBe(digestHealth([...rows]));
    expect(digestHealth(rows)).not.toBe(digestHealth([{ ...rows[0]!, consecutive_failures: 1 }]));
    expect(digestHealth(rows)).not.toBe(digestHealth([{ ...rows[0]!, last_success_at: "2026-10-16T00:01:00Z" }]));
  });
});
