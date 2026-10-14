import { describe, expect, it } from "vitest";
import { ThsError, type ThsMarketData, type ThsSnapshot } from "./ths.js";
import { runThsCycle, type ThsCycleStore, type ThsTarget } from "./ths-cycle.js";
import type { ThsTaskId } from "./ths-plan.js";

const TS = 1784275991000;

const TARGETS: ThsTarget[] = [
  { symbol: "SH000001", thscode: "000001.SH", kind: "index", auction: false },
  { symbol: "MOUTAI", thscode: "600519.SH", kind: "stock", auction: true },
];

function snapshotOf(rows: Array<{ thscode: string; last_price: number; price_change_ratio_pct?: number }>, timestamp: number | null = TS): ThsSnapshot {
  return {
    timestamp,
    total: rows.length,
    items: rows.map((row) => ({ ...row })),
  };
}

function fakeClient(overrides: Partial<ThsMarketData> = {}): { client: ThsMarketData; calls: string[] } {
  const calls: string[] = [];
  const base: ThsMarketData = {
    async indexSnapshot(codes) {
      calls.push(`index:${codes.join(",")}`);
      return snapshotOf([{ thscode: "000001.SH", last_price: 3388.06 }]);
    },
    async stockSnapshot(codes) {
      calls.push(`stock:${codes.join(",")}`);
      return snapshotOf([{ thscode: "600519.SH", last_price: 1277.8 }]);
    },
    async marketSnapshotPage(offset, limit) {
      calls.push(`market:${offset}:${limit}`);
      const total = 250;
      const count = Math.max(0, Math.min(limit, total - offset));
      const rows = Array.from({ length: count }, (_, i) => {
        const index = offset + i;
        const ratio = index % 3 === 0 ? 1.2 : index % 3 === 1 ? -0.8 : 0;
        return { thscode: `${600000 + index}.SH`, last_price: 10, price_change_ratio_pct: ratio };
      });
      return { timestamp: TS, total, items: rows.map((row) => ({ ...row })) };
    },
    async auctionSnapshot(codes, stage) {
      calls.push(`auction:${stage}:${codes.join(",")}`);
      return { item: [] };
    },
    async auctionBenchmark() {
      calls.push("auction_benchmark");
      return { item: [] };
    },
    async limitPool(name, page, size) {
      calls.push(`pool:${name}:${page}:${size}`);
      return { item: [{ thscode: "600001.SH" }] };
    },
    async limitUpLadder() {
      calls.push("ladder");
      return { item: [] };
    },
    async hotStock(period) {
      calls.push(`hot:${period}`);
      return { item: [] };
    },
    async skyrocket(period) {
      calls.push(`skyrocket:${period}`);
      return { item: [] };
    },
    async anomalyList() {
      calls.push("anomaly");
      return { item: [] };
    },
    async dragonTiger() {
      calls.push("dragon");
      return { item: [] };
    },
    async tradingDays() {
      return new Set(["2026-10-14"]);
    },
  };
  return { client: { ...base, ...overrides }, calls };
}

function fakeStore(existing: string[] = []) {
  const quotes: Array<{ symbol: string; price: number; ts: number }> = [];
  const payloads: Array<{ date: string; kind: string; payload: Record<string, unknown> }> = [];
  const health: string[] = [];
  const store: ThsCycleStore = {
    async upsertQuote(_symbol, _source, quote) {
      quotes.push(quote);
    },
    async upsertDailySnapshot(date, kind, payload) {
      payloads.push({ date, kind, payload });
    },
    async snapshotExists(_date, kind) {
      return existing.includes(kind);
    },
    async recordSourceSuccess() {
      health.push("success");
    },
    async recordSourceFailure(_source, error) {
      health.push(`failure:${error}`);
    },
  };
  return { store, quotes, payloads, health };
}

function run(
  tasks: ThsTaskId[],
  client: ThsMarketData,
  store: ThsCycleStore,
  overrides: { targets?: ThsTarget[]; deadlineMs?: number; concurrency?: number } = {},
) {
  return runThsCycle({
    client,
    store,
    tasks,
    targets: overrides.targets ?? TARGETS,
    date: "2026-10-14",
    now: () => TS,
    deadlineMs: overrides.deadlineMs ?? Number.MAX_SAFE_INTEGER,
    concurrency: overrides.concurrency ?? 4,
    log: () => {},
  });
}

describe("runThsCycle quotes", () => {
  it("writes index and stock prices as ths quotes with the snapshot timestamp", async () => {
    const { client } = fakeClient();
    const { store, quotes, health } = fakeStore();
    const result = await run(["index_snapshot", "stock_snapshot"], client, store);
    expect(result.outcome).toBe("ok");
    expect(quotes).toEqual([
      { symbol: "SH000001", price: 3388.06, ts: TS },
      { symbol: "MOUTAI", price: 1277.8, ts: TS },
    ]);
    expect(health).toEqual(["success"]);
  });

  it("treats a null snapshot timestamp as not ready and leaves source health alone", async () => {
    const { client } = fakeClient({
      async indexSnapshot() {
        return snapshotOf([], null);
      },
      async stockSnapshot() {
        return snapshotOf([], null);
      },
    });
    const { store, quotes, health } = fakeStore();
    const result = await run(["index_snapshot", "stock_snapshot"], client, store);
    expect(result.outcome).toBe("not_ready");
    expect(quotes).toEqual([]);
    expect(health).toEqual([]);
  });

  it("does not run a task when its target kind is absent", async () => {
    const { client, calls } = fakeClient();
    const { store } = fakeStore();
    const result = await run(["index_snapshot"], client, store, { targets: [TARGETS[1] as ThsTarget] });
    expect(result.tasks[0]?.status).toBe("skipped");
    expect(calls).toEqual([]);
  });
});

describe("runThsCycle failure handling", () => {
  it("keeps other endpoints running when one fails and reports the cycle as degraded", async () => {
    const { client } = fakeClient({
      async limitPool() {
        throw new ThsError("THS API code 5001: boom", "server", 5001);
      },
    });
    const { store, payloads, health } = fakeStore();
    const result = await run(["limit_up_pool", "index_snapshot"], client, store);
    expect(result.outcome).toBe("degraded");
    expect(payloads).toEqual([]);
    expect(result.tasks.find((t) => t.task === "limit_up_pool")?.status).toBe("failed");
    expect(result.tasks.find((t) => t.task === "index_snapshot")?.status).toBe("ok");
    expect(health).toEqual(["success"]);
  });

  it("stops new tasks after a rate limit and reports it for backoff", async () => {
    const { client, calls } = fakeClient({
      async indexSnapshot() {
        throw new ThsError("THS API code 4001: limited", "rate_limited", 4001);
      },
    });
    const { store, health } = fakeStore();
    const result = await runThsCycle({
      client,
      store,
      tasks: ["index_snapshot", "limit_up_ladder", "hot_stock_hour"],
      targets: TARGETS,
      date: "2026-10-14",
      now: () => TS,
      deadlineMs: Number.MAX_SAFE_INTEGER,
      concurrency: 1,
      log: () => {},
    });
    expect(result.outcome).toBe("rate_limited");
    expect(result.rateLimited).toBe(true);
    expect(result.tasks.map((t) => t.status)).toEqual(["rate_limited", "skipped", "skipped"]);
    expect(calls).not.toContain("ladder");
    expect(health[0]).toMatch(/^failure:/);
  });

  it("stops the whole cycle on an auth error", async () => {
    const { client, calls } = fakeClient({
      async stockSnapshot() {
        throw new ThsError("THS API code 2003: Invalid or revoked API key", "auth", 2003);
      },
    });
    const { store, health } = fakeStore();
    const result = await run(["stock_snapshot", "limit_up_ladder"], client, store, { targets: TARGETS, concurrency: 1 });
    expect(result.outcome).toBe("auth_error");
    expect(result.tasks.map((t) => t.status)).toEqual(["auth", "skipped"]);
    expect(calls).toEqual([]);
    expect(health[0]).toMatch(/^failure:THS API code 2003/);
  });

  it("skips every task once the deadline has passed", async () => {
    const { client, calls } = fakeClient();
    const { store } = fakeStore();
    const result = await run(["limit_up_ladder", "hot_stock_hour"], client, store, { deadlineMs: TS });
    expect(result.tasks.every((t) => t.status === "skipped")).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("runThsCycle payloads", () => {
  it("pages limit-up pools until a short page and stores the combined items", async () => {
    const pages: number[] = [];
    const { client } = fakeClient({
      async limitPool(_name, page) {
        pages.push(page);
        const count = page === 1 ? 200 : 3;
        return { item: Array.from({ length: count }, (_, i) => ({ thscode: `${600000 + i}.SH` })) };
      },
    });
    const { store, payloads } = fakeStore();
    const result = await run(["limit_up_pool"], client, store);
    expect(pages).toEqual([1, 2]);
    expect(result.outcome).toBe("ok");
    const [row] = payloads;
    expect(row?.kind).toBe("ths_limit_up_pool");
    expect((row?.payload.data as { item: unknown[]; pages: number }).item).toHaveLength(203);
    expect((row?.payload.data as { pages: number }).pages).toBe(2);
  });

  it("stores an empty dragon-tiger list as a successful write", async () => {
    const { client } = fakeClient({
      async dragonTiger() {
        return { item: [] };
      },
    });
    const { store, payloads } = fakeStore();
    const result = await run(["dragon_tiger"], client, store);
    expect(result.outcome).toBe("ok");
    expect(payloads[0]?.kind).toBe("ths_dragon_tiger");
  });

  it("aggregates breadth from paged market snapshots into one daily row", async () => {
    const { client, calls } = fakeClient();
    const { store, payloads } = fakeStore();
    await run(["breadth_close"], client, store);
    expect(calls.filter((c) => c.startsWith("market:"))).toEqual(["market:0:100", "market:100:100", "market:200:100"]);
    const data = payloads[0]?.payload.data as { total: number; sampled: number; up: number; down: number; flat: number; unknown: number };
    expect(payloads[0]?.kind).toBe("ths_breadth");
    expect(data.total).toBe(250);
    expect(data.sampled).toBe(250);
    expect(data.up + data.down + data.flat + data.unknown).toBe(250);
  });

  it("skips breadth when today's row already exists", async () => {
    const { client, calls } = fakeClient();
    const { store } = fakeStore(["ths_breadth"]);
    const result = await run(["breadth_close"], client, store);
    expect(result.tasks[0]?.status).toBe("skipped");
    expect(calls.some((c) => c.startsWith("market:"))).toBe(false);
  });

  it("sends only opted-in stock codes to auction-snapshot, with the stage from the task", async () => {
    const { client, calls } = fakeClient();
    const { store, payloads } = fakeStore();
    await run(["auction_live"], client, store);
    expect(calls).toContain("auction:live:600519.SH");
    expect(payloads[0]?.kind).toBe("ths_auction_live");
  });

  it("does not call auction-snapshot without an opted-in watchlist", async () => {
    const { client, calls } = fakeClient();
    const { store } = fakeStore();
    const result = await run(["auction_final"], client, store, { targets: [TARGETS[0] as ThsTarget] });
    expect(result.tasks[0]?.status).toBe("skipped");
    expect(calls.some((c) => c.startsWith("auction:"))).toBe(false);
  });
});
