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
    const now = Date.parse("2026-10-16T00:03:00Z");
    const rows = [
      { source: "okx", enabled: true, last_success_at: "2026-10-16T00:00:00Z", consecutive_failures: 0, max_staleness_minutes: 5, last_error: null },
    ];
    expect(digestHealth(rows, now)).toBe(digestHealth([...rows], now));
    expect(digestHealth(rows, now)).not.toBe(digestHealth([{ ...rows[0]!, consecutive_failures: 1 }], now));
    expect(digestHealth(rows, now)).not.toBe(digestHealth([{ ...rows[0]!, last_success_at: "2026-10-16T00:01:00Z" }], now));
  });

  it("health digest moves when a source ages past its staleness threshold", () => {
    const rows = [
      { source: "okx", enabled: true, last_success_at: "2026-10-16T00:00:00Z", consecutive_failures: 0, max_staleness_minutes: 5, last_error: null },
    ];
    const fresh = digestHealth(rows, Date.parse("2026-10-16T00:04:00Z"));
    // Same rows, one minute later the source crosses the 5-minute threshold: the
    // fingerprint must move so the stream triggers a page refresh.
    const stale = digestHealth(rows, Date.parse("2026-10-16T00:06:00Z"));
    expect(stale).not.toBe(fresh);
    // But within the same staleness state the digest stays put across ticks.
    expect(digestHealth(rows, Date.parse("2026-10-16T00:07:00Z"))).toBe(stale);
  });
});
