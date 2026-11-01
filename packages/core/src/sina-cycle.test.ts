import { describe, expect, it } from "vitest";
import { runSinaCycle, type SinaStore } from "./sina-cycle.js";
import { SinaRateLimitError, type SinaDaily, type SinaMarketData } from "./sina.js";
import type { Candle } from "./types.js";

const BAR: Candle = {
  ts: Date.UTC(2026, 9, 30),
  open: 42.35,
  high: 45.21,
  low: 42.26,
  close: 42.42,
  volume: 125791912,
  volCcy: 0,
  confirmed: true,
};

function fakeStore() {
  const writes: Array<{ symbol: string; source: string; interval: string; candles: readonly Candle[] }> = [];
  const health: string[] = [];
  const store: SinaStore = {
    async upsertCandles(symbol, source, interval, candles) {
      writes.push({ symbol, source, interval, candles });
      return candles.length;
    },
    async recordSourceSuccess(source) {
      health.push(`success:${source}`);
    },
    async recordSourceFailure(source, error) {
      health.push(`failure:${source}:${error}`);
    },
  };
  return { store, writes, health };
}

function fakeClient(daily: (sinaCode: string) => Promise<SinaDaily>): SinaMarketData {
  return { getDaily: daily };
}

describe("runSinaCycle", () => {
  it("writes 1D bars under source sina for every target and records success", async () => {
    const { store, writes, health } = fakeStore();
    const result = await runSinaCycle({
      client: fakeClient(async () => ({ candles: [BAR], rejected: 0 })),
      store,
      targets: [
        { symbol: "HTGD", sinaCode: "sh600487" },
        { symbol: "DML", sinaCode: "sz001309" },
      ],
      log: () => undefined,
    });
    expect(result).toMatchObject({ successes: 2, failures: 0, writeErrors: 0, persisted: 2, rateLimited: false });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ symbol: "HTGD", source: "sina", interval: "1D" });
    expect(writes[0]?.candles).toEqual([BAR]);
    expect(health).toEqual(["success:sina"]);
  });

  it("is idempotent: a rerun writes the same rows, so the database upsert cannot duplicate or drift them", async () => {
    const { store, writes } = fakeStore();
    const options = {
      client: fakeClient(async () => ({ candles: [BAR], rejected: 0 })),
      store,
      targets: [{ symbol: "HTGD", sinaCode: "sh600487" }],
      log: () => undefined,
    };
    await runSinaCycle(options);
    await runSinaCycle(options);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.candles).toEqual(writes[1]?.candles);
    expect(writes[0]?.candles[0]?.ts).toBe(writes[1]?.candles[0]?.ts);
  });

  it("continues past one symbol's failure and records failure only when nothing persisted", async () => {
    const { store, writes, health } = fakeStore();
    const result = await runSinaCycle({
      client: fakeClient(async (sinaCode) => {
        if (sinaCode === "sh600487") throw new Error("sina k-line sh600487 returned HTTP 500");
        return { candles: [BAR], rejected: 0 };
      }),
      store,
      targets: [
        { symbol: "HTGD", sinaCode: "sh600487" },
        { symbol: "DML", sinaCode: "sz001309" },
      ],
      log: () => undefined,
    });
    expect(result).toMatchObject({ successes: 1, failures: 1, persisted: 1 });
    expect(writes).toHaveLength(1);
    expect(health).toEqual(["success:sina"]);
  });

  it("stops after a rate-limit response and reports rate_limited", async () => {
    const requested: string[] = [];
    const { store } = fakeStore();
    const result = await runSinaCycle({
      client: fakeClient(async (sinaCode) => {
        requested.push(sinaCode);
        throw new SinaRateLimitError(`sina k-line ${sinaCode} returned HTTP 403`, 403);
      }),
      store,
      targets: [
        { symbol: "HTGD", sinaCode: "sh600487" },
        { symbol: "DML", sinaCode: "sz001309" },
      ],
      concurrency: 1,
      log: () => undefined,
    });
    expect(result.rateLimited).toBe(true);
    expect(requested).toEqual(["sh600487"]);
  });
});
