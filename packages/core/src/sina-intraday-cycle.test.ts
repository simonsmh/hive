import { describe, expect, it } from "vitest";
import { aggregate15m, runSinaIntradayCycle, type SinaIntradayStore } from "./sina-intraday-cycle.js";
import { SinaRateLimitError, type SinaIntraday, type SinaIntradayData } from "./sina.js";
import type { Candle } from "./types.js";

const BAR: Candle = {
  ts: Date.UTC(2026, 10, 2, 3, 25),
  open: 3.868,
  high: 3.887,
  low: 3.861,
  close: 3.872,
  volume: 224677235,
  volCcy: 0,
  confirmed: true,
};

function fakeStore() {
  const writes: Array<{ symbol: string; source: string; interval: string; candles: readonly Candle[] }> = [];
  const health: string[] = [];
  const store: SinaIntradayStore = {
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

function fakeClient(intraday: (sinaCode: string) => Promise<SinaIntraday>): SinaIntradayData {
  return { getIntraday: intraday };
}

describe("aggregate15m", () => {
  // 2026-11-05 morning session: 09:30, 09:35, 09:40, 09:45, 09:50, 09:55 CST = 01:30..01:55 UTC.
  const bar = (ts: string, open: number, high: number, low: number, close: number, volume: number, confirmed = true): Candle => ({
    ts: Date.parse(ts),
    open,
    high,
    low,
    close,
    volume,
    volCcy: 0,
    confirmed,
  });

  it("builds one 15m bar per complete confirmed window with summed volume", () => {
    const bars = [
      bar("2026-11-05T01:30:00.000Z", 2.5, 2.52, 2.49, 2.51, 100),
      bar("2026-11-05T01:35:00.000Z", 2.51, 2.55, 2.5, 2.54, 200),
      bar("2026-11-05T01:40:00.000Z", 2.54, 2.56, 2.53, 2.53, 300),
      bar("2026-11-05T01:45:00.000Z", 2.53, 2.54, 2.52, 2.52, 400),
      bar("2026-11-05T01:50:00.000Z", 2.52, 2.53, 2.51, 2.51, 500),
      bar("2026-11-05T01:55:00.000Z", 2.51, 2.52, 2.5, 2.5, 600),
    ];
    expect(aggregate15m(bars)).toEqual([
      {
        ts: Date.parse("2026-11-05T01:30:00.000Z"),
        open: 2.5,
        high: 2.56,
        low: 2.49,
        close: 2.53,
        volume: 600,
        volCcy: 0,
        confirmed: true,
      },
      {
        ts: Date.parse("2026-11-05T01:45:00.000Z"),
        open: 2.53,
        high: 2.54,
        low: 2.5,
        close: 2.5,
        volume: 1500,
        volCcy: 0,
        confirmed: true,
      },
    ]);
  });

  it("skips windows with a missing middle bar or an unconfirmed bar", () => {
    const gap = [
      bar("2026-11-05T01:30:00.000Z", 2.5, 2.52, 2.49, 2.51, 100),
      bar("2026-11-05T01:40:00.000Z", 2.54, 2.56, 2.53, 2.53, 300),
    ];
    expect(aggregate15m(gap)).toEqual([]);
    const unconfirmed = [
      bar("2026-11-05T01:30:00.000Z", 2.5, 2.52, 2.49, 2.51, 100),
      bar("2026-11-05T01:35:00.000Z", 2.51, 2.55, 2.5, 2.54, 200),
      bar("2026-11-05T01:40:00.000Z", 2.54, 2.56, 2.53, 2.53, 300, false),
    ];
    expect(aggregate15m(unconfirmed)).toEqual([]);
  });

  it("does not merge the morning close with the afternoon open", () => {
    const bars = [
      bar("2026-11-05T03:15:00.000Z", 2.5, 2.52, 2.49, 2.51, 100),
      bar("2026-11-05T03:20:00.000Z", 2.51, 2.55, 2.5, 2.54, 200),
      bar("2026-11-05T03:25:00.000Z", 2.54, 2.56, 2.53, 2.53, 300),
      bar("2026-11-05T05:00:00.000Z", 2.53, 2.54, 2.52, 2.52, 400),
      bar("2026-11-05T05:05:00.000Z", 2.52, 2.53, 2.51, 2.51, 500),
      bar("2026-11-05T05:10:00.000Z", 2.51, 2.52, 2.5, 2.5, 600),
    ];
    const aggregated = aggregate15m(bars);
    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]?.ts).toBe(Date.parse("2026-11-05T03:15:00.000Z"));
    expect(aggregated[1]?.ts).toBe(Date.parse("2026-11-05T05:00:00.000Z"));
  });
});

describe("runSinaIntradayCycle", () => {
  it("writes 5m bars under source sina for every target and records success", async () => {
    const { store, writes, health } = fakeStore();
    const result = await runSinaIntradayCycle({
      client: fakeClient(async () => ({ candles: [BAR], rejected: 0 })),
      store,
      targets: [{ symbol: "SH513310", sinaCode: "sh513310" }],
      log: () => undefined,
    });
    expect(result).toMatchObject({ successes: 1, failures: 0, writeErrors: 0, persisted: 1, rateLimited: false });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ symbol: "SH513310", source: "sina", interval: "5m" });
    expect(writes[0]?.candles).toEqual([BAR]);
    expect(health).toEqual(["success:sina"]);
  });

  it("writes the 15m bars aggregated from complete confirmed 5m windows", async () => {
    const { store, writes } = fakeStore();
    const bars: Candle[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      ts: Date.parse("2026-11-05T01:30:00.000Z") + i * 5 * 60_000,
      open: 2.5,
      high: 2.56,
      low: 2.49,
      close: 2.53,
      volume: 100,
      volCcy: 0,
      confirmed: true,
    }));
    await runSinaIntradayCycle({
      client: fakeClient(async () => ({ candles: bars, rejected: 0 })),
      store,
      targets: [{ symbol: "SZ159915", sinaCode: "sz159915" }],
      log: () => undefined,
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ symbol: "SZ159915", interval: "5m" });
    expect(writes[0]?.candles).toHaveLength(6);
    expect(writes[1]).toMatchObject({ symbol: "SZ159915", source: "sina", interval: "15m" });
    expect(writes[1]?.candles).toHaveLength(2);
    expect(writes[1]?.candles[0]).toMatchObject({
      ts: Date.parse("2026-11-05T01:30:00.000Z"),
      open: 2.5,
      high: 2.56,
      low: 2.49,
      close: 2.53,
      volume: 300,
      confirmed: true,
    });
  });

  it("skips the 15m write when no window is complete", async () => {
    const { store, writes } = fakeStore();
    await runSinaIntradayCycle({
      client: fakeClient(async () => ({ candles: [BAR], rejected: 0 })),
      store,
      targets: [{ symbol: "SH513310", sinaCode: "sh513310" }],
      log: () => undefined,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.interval).toBe("5m");
  });

  it("asks the client for 5-minute bars", async () => {
    const requested: Array<{ sinaCode: string; intervalMinutes: number }> = [];
    const { store } = fakeStore();
    await runSinaIntradayCycle({
      client: {
        async getIntraday(sinaCode, intervalMinutes) {
          requested.push({ sinaCode, intervalMinutes });
          return { candles: [BAR], rejected: 0 };
        },
      },
      store,
      targets: [{ symbol: "SH513310", sinaCode: "sh513310" }],
      log: () => undefined,
    });
    expect(requested).toEqual([{ sinaCode: "sh513310", intervalMinutes: 5 }]);
  });

  it("is idempotent: a rerun writes the same rows, so the database upsert cannot duplicate or drift them", async () => {
    const { store, writes } = fakeStore();
    const options = {
      client: fakeClient(async () => ({ candles: [BAR], rejected: 0 })),
      store,
      targets: [{ symbol: "SH513310", sinaCode: "sh513310" }],
      log: () => undefined,
    };
    await runSinaIntradayCycle(options);
    await runSinaIntradayCycle(options);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.candles).toEqual(writes[1]?.candles);
    expect(writes[0]?.candles[0]?.ts).toBe(writes[1]?.candles[0]?.ts);
  });

  it("continues past one symbol's failure and records failure only when nothing persisted", async () => {
    const { store, writes, health } = fakeStore();
    const result = await runSinaIntradayCycle({
      client: fakeClient(async (sinaCode) => {
        if (sinaCode === "sh513310") throw new Error("sina k-line sh513310 returned HTTP 500");
        return { candles: [BAR], rejected: 0 };
      }),
      store,
      targets: [
        { symbol: "SH513310", sinaCode: "sh513310" },
        { symbol: "OTHER", sinaCode: "sh600487" },
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
    const result = await runSinaIntradayCycle({
      client: fakeClient(async (sinaCode) => {
        requested.push(sinaCode);
        throw new SinaRateLimitError(`sina k-line ${sinaCode} returned HTTP 403`, 403);
      }),
      store,
      targets: [
        { symbol: "SH513310", sinaCode: "sh513310" },
        { symbol: "OTHER", sinaCode: "sh600487" },
      ],
      concurrency: 1,
      log: () => undefined,
    });
    expect(result.rateLimited).toBe(true);
    expect(requested).toEqual(["sh513310"]);
  });
});
