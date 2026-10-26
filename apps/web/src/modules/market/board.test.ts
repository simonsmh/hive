import { describe, expect, it } from "vitest";
import { buildMarketBoard, type SnapshotRow } from "./board";

const industryRow: SnapshotRow = {
  snapshot_date: "2026-10-27",
  kind: "ths_industry",
  payload: {
    fetched_at: "2026-10-27T02:00:00.000Z",
    data: {
      entries: [
        { thscode: "880001.TI", name: "石油化工", price: 100, pct: 2.5 },
        { thscode: "880002.TI", name: "券商", price: 200, pct: -1.2 },
        { thscode: "880003.TI", name: "无涨跌", price: 300, pct: null },
      ],
      speed: [
        { thscode: "880001.TI", speedPct: 0.6, refTs: 1 },
        { thscode: "880002.TI", speedPct: -0.4, refTs: 1 },
      ],
    },
  },
};

const breadthRow: SnapshotRow = {
  snapshot_date: "2026-10-27",
  kind: "ths_breadth",
  payload: {
    data: {
      total: 4,
      up: 1,
      down: 1,
      flat: 1,
      unknown: 1,
      bins: Array.from({ length: 21 }, (_, i) => (i === 12 ? 1 : i === 7 ? 1 : 0)),
      markets: {
        all: { total: 4, up: 1, down: 1, flat: 1, unknown: 1, bins: Array.from({ length: 21 }, () => 0) },
        sh: { total: 2, up: 1, down: 0, flat: 1, unknown: 0, bins: Array.from({ length: 21 }, () => 0) },
      },
      points: [
        {
          ts: 1,
          total: 4,
          up: 1,
          down: 1,
          flat: 1,
          unknown: 1,
          bins: Array.from({ length: 21 }, (_, i) => (i === 12 ? 1 : i === 7 ? 1 : 0)),
          markets: {
            all: { total: 4, up: 1, down: 1, flat: 1, unknown: 1, bins: Array.from({ length: 21 }, () => 0) },
            sh: { total: 2, up: 1, down: 0, flat: 1, unknown: 0, bins: Array.from({ length: 21 }, () => 0) },
          },
        },
      ],
    },
  },
};

describe("buildMarketBoard", () => {
  it("ranks industry up/down and speed, and keeps the latest breadth point", () => {
    const board = buildMarketBoard([industryRow, breadthRow]);
    expect(board.date).toBe("2026-10-27");
    expect(board.industryUp.map((row) => row.name)).toEqual(["石油化工", "券商"]);
    expect(board.industryDown.map((row) => row.name)).toEqual(["券商", "石油化工"]);
    expect(board.speedUp.map((row) => row.name)).toEqual(["石油化工", "券商"]);
    expect(board.speedDown.map((row) => row.name)).toEqual(["券商", "石油化工"]);
    expect(board.breadth?.total).toBe(4);
    expect(board.breadth?.markets?.["sh"]?.total).toBe(2);
    expect(board.limitUp).toBeNull();
  });

  it("returns an empty board when nothing was collected", () => {
    const board = buildMarketBoard([]);
    expect(board.date).toBeNull();
    expect(board.industryUp).toEqual([]);
    expect(board.breadth).toBeNull();
  });

  it("does not mix limit counts from another session into today's breadth", () => {
    const board = buildMarketBoard([
      breadthRow,
      { snapshot_date: "2026-10-26", kind: "ths_limit_up_pool", payload: { data: { item: [1, 2, 3] } } },
      { snapshot_date: "2026-10-26", kind: "ths_limit_down_pool", payload: { data: { item: [1] } } },
    ]);
    expect(board.breadthDate).toBe("2026-10-27");
    expect(board.limitsDate).toBe("2026-10-26");
    expect(board.limitUp).toBeNull();
    expect(board.limitDown).toBeNull();
  });

  it("combines limit counts when they share the breadth session", () => {
    const board = buildMarketBoard([
      breadthRow,
      { snapshot_date: "2026-10-27", kind: "ths_limit_up_pool", payload: { data: { item: [1, 2, 3] } } },
      { snapshot_date: "2026-10-27", kind: "ths_limit_down_pool", payload: { data: { item: [1] } } },
    ]);
    expect(board.limitUp).toBe(3);
    expect(board.limitDown).toBe(1);
  });

  it("tolerates the old counts-only breadth shape", () => {
    const board = buildMarketBoard([
      { snapshot_date: "2026-10-26", kind: "ths_breadth", payload: { data: { total: 10, up: 4, down: 5, flat: 1, unknown: 0 } } },
    ]);
    expect(board.breadth?.total).toBe(10);
    expect(board.breadth?.bins).toBeNull();
    expect(board.breadth?.markets).toBeNull();
  });
});
