// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
const BEIJING_OFFSET_MS = 8 * 3600_000;

export interface BeijingClock {
  /** Asia/Shanghai calendar date, YYYY-MM-DD. */
  date: string;
  /** Minutes since Asia/Shanghai midnight. */
  minute: number;
  /** 1 = Monday ... 7 = Sunday. */
  isoWeekday: number;
}

export function beijingDate(epochMs: number): string {
  return new Date(epochMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function beijingClock(epochMs: number): BeijingClock {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    isoWeekday: shifted.getUTCDay() || 7,
  };
}

/** From 15:00 Beijing time the closing breadth point is retried every tick until captured (see ths-cycle). */
export const BREADTH_CLOSING_MINUTE = 15 * 60;
export const SESSION_START_MINUTE = 9 * 60 + 15;
/** Exclusive. The last poll is at 15:14 Beijing time. */
export const SESSION_END_MINUTE = 15 * 60 + 15;
export const AUCTION_LIVE_END_MINUTE = 9 * 60 + 25;
export const AUCTION_FINAL_END_MINUTE = 9 * 60 + 40;

/** Weekday window only. Exchange holidays are handled by the trading calendar, not here. */
export function inSession(clock: BeijingClock): boolean {
  return clock.isoWeekday <= 5 && clock.minute >= SESSION_START_MINUTE && clock.minute < SESSION_END_MINUTE;
}

export type ThsTaskId =
  | "index_snapshot"
  | "stock_snapshot"
  | "limit_up_pool"
  | "limit_down_pool"
  | "limit_break_pool"
  | "limit_up_ladder"
  | "hot_stock_hour"
  | "hot_stock_day"
  | "skyrocket_day"
  | "anomaly_list"
  | "dragon_tiger"
  | "auction_benchmark"
  | "auction_live"
  | "auction_final"
  | "industry_board"
  | "breadth";

/**
 * Tasks for one tick. Every tick runs the cheap every-2-minute group, including
 * the industry board (its 2-minute cadence is what makes the 5-minute speed
 * computable from the stored history points). Slower lists run on 10-minute
 * boundaries (the tick is aligned to even minutes). Auction tasks need an
 * opt-in watchlist. Breadth pages the whole market (~56 requests), so it runs
 * on 30-minute boundaries and appends one point per run to today's row.
 * From 15:00 it is scheduled on every tick so a skipped or failed closing
 * run is retried before the 15:15 session end; the task itself skips once
 * a closing point is stored, so a captured close costs no extra requests.
 */
export function planTick(clock: BeijingClock, options: { hasAuctionWatchlist: boolean }): ThsTaskId[] {
  if (!inSession(clock)) return [];
  const tasks: ThsTaskId[] = [
    "index_snapshot",
    "stock_snapshot",
    "limit_up_pool",
    "limit_down_pool",
    "limit_break_pool",
    "limit_up_ladder",
    "hot_stock_hour",
    "industry_board",
  ];
  if (clock.minute % 10 === 0) {
    tasks.push("hot_stock_day", "skyrocket_day", "anomaly_list", "dragon_tiger", "auction_benchmark");
  }
  if (options.hasAuctionWatchlist) {
    if (clock.minute < AUCTION_LIVE_END_MINUTE) tasks.push("auction_live");
    else if (clock.minute < AUCTION_FINAL_END_MINUTE) tasks.push("auction_final");
  }
  if (clock.minute % 30 === 0 || clock.minute >= BREADTH_CLOSING_MINUTE) tasks.push("breadth");
  return tasks;
}
