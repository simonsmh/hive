import { describe, expect, it } from "vitest";
import { beijingClock, beijingDate, inSession, planTick, type BeijingClock } from "./ths-plan.js";

const at = (iso: string) => Date.parse(iso);

describe("beijingClock", () => {
  it("maps UTC instants to the Asia/Shanghai date, minute and ISO weekday", () => {
    expect(beijingClock(at("2026-10-14T01:20:00Z"))).toEqual({ date: "2026-10-14", minute: 9 * 60 + 20, isoWeekday: 3 });
    expect(beijingClock(at("2026-10-13T16:30:00Z"))).toEqual({ date: "2026-10-14", minute: 0 + 30, isoWeekday: 3 });
    expect(beijingClock(at("2026-10-18T06:00:00Z"))).toEqual({ date: "2026-10-18", minute: 14 * 60, isoWeekday: 7 });
  });

  it("formats the trading date for an epoch in milliseconds", () => {
    expect(beijingDate(at("2026-10-14T15:59:00Z"))).toBe("2026-10-14");
    expect(beijingDate(at("2026-10-14T16:00:00Z"))).toBe("2026-10-15");
  });
});

describe("inSession", () => {
  const clock = (minute: number, isoWeekday = 3): BeijingClock => ({ date: "2026-10-14", minute, isoWeekday });

  it("opens at 09:15 and closes before 15:15 on weekdays only", () => {
    expect(inSession(clock(9 * 60 + 14))).toBe(false);
    expect(inSession(clock(9 * 60 + 15))).toBe(true);
    expect(inSession(clock(15 * 60 + 14))).toBe(true);
    expect(inSession(clock(15 * 60 + 15))).toBe(false);
    expect(inSession(clock(10 * 60, 6))).toBe(false);
    expect(inSession(clock(10 * 60, 7))).toBe(false);
  });
});

describe("planTick", () => {
  const clock = (minute: number): BeijingClock => ({ date: "2026-10-14", minute, isoWeekday: 3 });

  it("plans nothing outside the session", () => {
    expect(planTick(clock(9 * 60), { hasAuctionWatchlist: true })).toEqual([]);
  });

  it("runs the cheap group every tick and the slow group only on 10-minute boundaries", () => {
    const cheap = planTick(clock(10 * 60 + 2), { hasAuctionWatchlist: false });
    expect(cheap).toEqual([
      "index_snapshot",
      "stock_snapshot",
      "limit_up_pool",
      "limit_down_pool",
      "limit_break_pool",
      "limit_up_ladder",
      "hot_stock_hour",
      "industry_board",
    ]);
    const boundary = planTick(clock(10 * 60), { hasAuctionWatchlist: false });
    expect(boundary).toContain("dragon_tiger");
    expect(boundary).toContain("skyrocket_day");
  });

  it("runs auction live before 09:25, final until 09:40, and only with a watchlist", () => {
    expect(planTick(clock(9 * 60 + 16), { hasAuctionWatchlist: true })).toContain("auction_live");
    expect(planTick(clock(9 * 60 + 26), { hasAuctionWatchlist: true })).toContain("auction_final");
    expect(planTick(clock(9 * 60 + 26), { hasAuctionWatchlist: true })).not.toContain("auction_live");
    expect(planTick(clock(9 * 60 + 40), { hasAuctionWatchlist: true })).not.toContain("auction_final");
    expect(planTick(clock(9 * 60 + 16), { hasAuctionWatchlist: false })).not.toContain("auction_live");
  });

  it("schedules breadth on 30-minute boundaries", () => {
    expect(planTick(clock(10 * 60 + 2), { hasAuctionWatchlist: false })).not.toContain("breadth");
    expect(planTick(clock(10 * 60 + 30), { hasAuctionWatchlist: false })).toContain("breadth");
  });
});
