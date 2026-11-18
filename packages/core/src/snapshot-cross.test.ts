import { describe, expect, it } from "vitest";
import {
  evaluateSnapshotCross,
  isFreshQuote,
  parseSnapshotCrossParams,
  SnapshotCrossError,
} from "./snapshot-cross.js";

const params = parseSnapshotCrossParams({ kind: "snapshot_cross", level: 3720, direction: "below", once: true });

describe("parseSnapshotCrossParams", () => {
  it("defaults once to true and maxQuoteAgeSeconds to 480", () => {
    expect(params).toEqual({
      kind: "snapshot_cross",
      level: 3720,
      direction: "below",
      once: true,
      maxQuoteAgeSeconds: 480,
    });
  });

  it("rejects a non-positive level", () => {
    expect(() => parseSnapshotCrossParams({ level: 0, direction: "below" })).toThrow(SnapshotCrossError);
  });
});

describe("evaluateSnapshotCross", () => {
  const armed = { price: 3769.12, ts: 1_000 };
  const broken = { price: 3719.5, ts: 2_000 };

  it("does not fire on the first quote, even if that quote is already at or below the level", () => {
    expect(evaluateSnapshotCross(params, null, broken)).toBe(false);
    expect(evaluateSnapshotCross(params, null, armed)).toBe(false);
  });

  it("fires once price moves from above the level to at or below it", () => {
    expect(evaluateSnapshotCross(params, armed, broken)).toBe(true);
    expect(evaluateSnapshotCross(params, armed, { price: 3720, ts: 2_000 })).toBe(true);
  });

  it("does not fire when both quotes stay above the level, or when the quote is not newer", () => {
    expect(evaluateSnapshotCross(params, armed, { price: 3750, ts: 2_000 })).toBe(false);
    expect(evaluateSnapshotCross(params, armed, { price: 3710, ts: 1_000 })).toBe(false);
  });

  it("does not treat an already-below first observation followed by a still-below quote as a new break", () => {
    const first = { price: 3710, ts: 1_000 };
    const later = { price: 3700, ts: 2_000 };
    expect(evaluateSnapshotCross(params, first, later)).toBe(false);
  });
});

describe("isFreshQuote", () => {
  const ts = Date.parse("2026-11-18T13:23:30Z");
  it("accepts a quote inside the age window and rejects a stale one", () => {
    expect(isFreshQuote(ts, 480, ts + 120_000)).toBe(true);
    expect(isFreshQuote(ts, 480, ts + 481_000)).toBe(false);
  });
});
