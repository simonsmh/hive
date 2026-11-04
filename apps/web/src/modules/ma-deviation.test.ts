import { describe, expect, it } from "vitest";
import { computeDeviations, weightedDeviation, buildRow, loadMaDeviationBoard } from "./ma-deviation";

describe("loadMaDeviationBoard", () => {
  it("uses null (not NaN) for failed instruments, so JSON round-trips without crashing the panel", async () => {
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const board = await loadMaDeviationBoard(failingFetch);
    expect(board.rows.length).toBeGreaterThan(0);
    expect(board.rows.every((row) => row.lastClose === null)).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(board)) as typeof board;
    expect(roundTripped.rows.every((row) => row.lastClose === null)).toBe(true);
  });
});

describe("computeDeviations", () => {
  it("returns null until 20 closes, then (close - MA20) / MA20 in percent", () => {
    const closes = Array.from({ length: 21 }, (_, i) => 100 + i);
    const devs = computeDeviations(closes);
    expect(devs.slice(0, 19)).toEqual(Array(19).fill(null));
    // MA20 of 101..120 is 110.5; last close 120 -> +8.597%.
    expect(devs[20]).toBeCloseTo(((120 - 110.5) / 110.5) * 100, 6);
  });
});

describe("weightedDeviation", () => {
  it("weights the last 5 deviations 1..5 far to near", () => {
    // Only the last 5 matter; earlier entries are ignored.
    const devs = [99, 99, -5, -3, 0, 2, 4];
    // (1*-5 + 2*-3 + 3*0 + 4*2 + 5*4) / 15 = 17/15.
    expect(weightedDeviation(devs)).toBeCloseTo(17 / 15, 6);
  });

  it("returns null when the last window is incomplete or contains null", () => {
    expect(weightedDeviation([1, 2, 3])).toBeNull();
    expect(weightedDeviation([1, 2, 3, 4, null])).toBeNull();
  });
});

describe("buildRow", () => {  it("computes W and W_prev from consecutive 5-bar windows", () => {
    // Flat 100 for 25 bars, then a jump to 110: the last window's
    // deviations are positive and rising, the previous window is ~0.
    const bars = [
      ...Array.from({ length: 25 }, (_, i) => ({ ts: i, close: 100 })),
      ...Array.from({ length: 5 }, (_, i) => ({ ts: 25 + i, close: 110 })),
    ];
    const row = buildRow("TEST", "TEST-USDT-SWAP", bars);
    expect(row.w).not.toBeNull();
    expect(row.wPrev).not.toBeNull();
    expect((row.w as number) - (row.wPrev as number)).toBeGreaterThan(0);
  });
});
