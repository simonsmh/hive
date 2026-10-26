// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
import {
  THS_BATCH_SIZE,
  THS_MARKET_PAGE_SIZE,
  ThsError,
  itemsOf,
  quoteOf,
  type ThsMarketData,
  type ThsSnapshot,
} from "./ths.ts";
import {
  breadthPointsOf,
  buildBreadthPoint,
  buildIndustryEntries,
  computeIndustrySpeed,
  historyOf,
  hs300Of,
  parseConstituents,
  parseIndustryCatalog,
  pruneIndustryHistory,
} from "./ths-market.ts";
import { type ThsTaskId } from "./ths-plan.ts";
import type { Source } from "./types.ts";

export interface ThsTarget {
  symbol: string;
  thscode: string;
  kind: "stock" | "index";
  /** Opt-in: stock rows included in auction-snapshot. */
  auction: boolean;
}

export interface ThsCycleStore {
  upsertQuote(symbol: string, source: Source, quote: { symbol: string; price: number; ts: number }): Promise<void>;
  upsertDailySnapshot(date: string, kind: string, payload: Record<string, unknown>): Promise<void>;
  /** Full stored payload for a daily row, or null when the row does not exist yet. */
  readDailySnapshot(date: string, kind: string): Promise<Record<string, unknown> | null>;
  snapshotExists(date: string, kind: string): Promise<boolean>;
  recordSourceSuccess(source: Source): Promise<void>;
  recordSourceFailure(source: Source, error: string): Promise<void>;
}

export type ThsTaskStatus = "ok" | "not_ready" | "failed" | "rate_limited" | "auth" | "skipped";

export interface ThsTaskOutcome {
  task: ThsTaskId;
  status: ThsTaskStatus;
  persisted: number;
  error?: string;
}

export type ThsCycleOutcome = "ok" | "degraded" | "failed" | "rate_limited" | "auth_error" | "not_ready" | "idle";

export interface ThsCycleOptions {
  client: ThsMarketData;
  store: ThsCycleStore;
  tasks: readonly ThsTaskId[];
  targets: readonly ThsTarget[];
  /** Asia/Shanghai date used for daily_snapshot rows. */
  date: string;
  now: () => number;
  /** No task starts at or after this epoch-ms deadline. */
  deadlineMs: number;
  concurrency: number;
  log: (message: string) => void;
}

export interface ThsCycleResult {
  outcome: ThsCycleOutcome;
  tasks: ThsTaskOutcome[];
  persisted: number;
  rateLimited: boolean;
}

const MARKET_BREADTH_MAX_PAGES = 100;
const POOL_PAGE_SIZE = 200;
const POOL_MAX_PAGES = 5;
const MAX_ERROR_LENGTH = 300;

async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function timestampOf(data: unknown): number | null {
  if (typeof data !== "object" || data === null || !("timestamp" in data)) return null;
  const value = (data as { timestamp: unknown }).timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function taskKind(task: ThsTaskId): string | null {
  switch (task) {
    case "limit_up_pool":
      return "ths_limit_up_pool";
    case "limit_down_pool":
      return "ths_limit_down_pool";
    case "limit_break_pool":
      return "ths_limit_break_pool";
    case "limit_up_ladder":
      return "ths_limit_up_ladder";
    case "hot_stock_hour":
      return "ths_hot_stock_hour";
    case "hot_stock_day":
      return "ths_hot_stock_day";
    case "skyrocket_day":
      return "ths_skyrocket_day";
    case "anomaly_list":
      return "ths_anomaly_list";
    case "dragon_tiger":
      return "ths_dragon_tiger";
    case "auction_benchmark":
      return "ths_auction_benchmark";
    case "industry_board":
      return "ths_industry";
    case "breadth":
      return "ths_breadth";
    default:
      return null;
  }
}

/**
 * Runs one tick's tasks. A single failing endpoint is recorded and the others still run. Source health is success
 * when any task persisted data, and failure only when nothing did. A rate limit stops new tasks and sets the outcome
 * so the caller can back off. An auth failure stops the cycle, since every endpoint would fail the same way.
 */
export async function runThsCycle(options: ThsCycleOptions): Promise<ThsCycleResult> {
  const { client, store, targets, date, log } = options;
  let stopped: "rate_limited" | "auth" | null = null;

  const targetsFor = (task: ThsTaskId): ThsTarget[] => {
    switch (task) {
      case "index_snapshot":
        return targets.filter((t) => t.kind === "index");
      case "stock_snapshot":
        return targets.filter((t) => t.kind === "stock");
      case "auction_live":
      case "auction_final":
        return targets.filter((t) => t.kind === "stock" && t.auction);
      default:
        return [];
    }
  };

  const needsTargets = (task: ThsTaskId) =>
    task === "index_snapshot" || task === "stock_snapshot" || task === "auction_live" || task === "auction_final";

  const storePayload = async (kind: string, data: unknown, timestamp: number | null): Promise<number> => {
    await store.upsertDailySnapshot(date, kind, {
      fetched_at: new Date(options.now()).toISOString(),
      timestamp,
      data,
    });
    return 1;
  };

  const quoteTask = async (kind: "index" | "stock"): Promise<number> => {
    const selected = targetsFor(kind === "index" ? "index_snapshot" : "stock_snapshot");
    let persisted = 0;
    for (let i = 0; i < selected.length; i += THS_BATCH_SIZE) {
      const batch = selected.slice(i, i + THS_BATCH_SIZE);
      const codes = batch.map((t) => t.thscode);
      const snapshot: ThsSnapshot =
        kind === "index" ? await client.indexSnapshot(codes) : await client.stockSnapshot(codes);
      if (snapshot.timestamp === null) {
        throw new ThsError(`${kind} snapshot returned no valid data`, "not_ready");
      }
      const prices = new Map<string, number>();
      for (const item of snapshot.items) {
        const quote = quoteOf(item);
        if (quote) prices.set(quote.thscode, quote.lastPrice);
      }
      for (const target of batch) {
        const price = prices.get(target.thscode);
        if (price === undefined) continue;
        await store.upsertQuote(target.symbol, "ths", { symbol: target.symbol, price, ts: snapshot.timestamp });
        persisted += 1;
      }
    }
    if (persisted === 0) throw new ThsError(`no ${kind} quote returned for ${selected.length} symbols`, "not_ready");
    return persisted;
  };

  const pagedPool = async (name: "limit-up-pool" | "limit-down-pool" | "limit-break-pool") => {
    const item: Record<string, unknown>[] = [];
    let pages = 0;
    let timestamp: number | null = null;
    for (let page = 1; page <= POOL_MAX_PAGES; page += 1) {
      const data = await client.limitPool(name, page, POOL_PAGE_SIZE);
      pages += 1;
      const rows = itemsOf(data);
      if (page === 1) timestamp = timestampOf(data);
      item.push(...rows);
      if (rows.length < POOL_PAGE_SIZE) break;
    }
    return { data: { item, pages }, timestamp };
  };

  const industryTask = async (): Promise<number> => {
    const catalog = parseIndustryCatalog(await client.indexCatalog());
    if (catalog.length === 0) throw new ThsError("industry catalog returned no indices", "not_ready");
    const entries: ReturnType<typeof buildIndustryEntries> = [];
    let timestamp: number | null = null;
    for (let i = 0; i < catalog.length; i += THS_BATCH_SIZE) {
      const batch = catalog.slice(i, i + THS_BATCH_SIZE);
      const snapshot = await client.indexSnapshot(batch.map((row) => row.thscode));
      if (snapshot.timestamp === null) throw new ThsError("industry snapshot returned no valid data", "not_ready");
      if (timestamp === null) timestamp = snapshot.timestamp;
      entries.push(...buildIndustryEntries(catalog, snapshot.items));
    }
    if (entries.length === 0) throw new ThsError("industry snapshot returned no valid data", "not_ready");
    const previous = await store.readDailySnapshot(date, "ths_industry");
    const history = historyOf(previous);
    const current = new Map(
      entries.filter((entry) => entry.price !== null).map((entry) => [entry.thscode, entry.price as number]),
    );
    const speed = computeIndustrySpeed(history, current, options.now());
    const pointTs = timestamp ?? options.now();
    const newHistory = pruneIndustryHistory(
      [...history, { ts: pointTs, prices: Object.fromEntries(current) }],
      options.now(),
    );
    return storePayload(
      "ths_industry",
      { entries, speed, history: newHistory, count: entries.length },
      timestamp,
    );
  };

  const breadthTask = async (): Promise<number> => {
    const previous = await store.readDailySnapshot(date, "ths_breadth");
    let hs300 = new Set(hs300Of(previous));
    if (hs300.size === 0) {
      try {
        const codes = parseConstituents(await client.indexConstituents("000300.SH"));
        if (codes.length > 0) hs300 = new Set(codes);
      } catch (error) {
        // A rate limit must still stop the cycle and trigger its backoff:
        // swallowing it here would let the ~56 market-page requests below
        // run anyway while the cycle reports success.
        if (error instanceof ThsError && error.kind === "rate_limited") throw error;
        // HS300 is one tab of the board, not the board itself: degrade to the
        // other markets instead of failing the whole breadth point.
        log(`hs300 constituents unavailable, breadth without hs300: ${messageOf(error)}`);
      }
    }
    const first = await client.marketSnapshotPage(0, THS_MARKET_PAGE_SIZE);
    if (first.timestamp === null) throw new ThsError("market snapshot returned no valid data", "not_ready");
    if (first.total === null) throw new ThsError("market snapshot has no total", "malformed");
    const total = first.total;
    const offsets: number[] = [];
    for (let offset = THS_MARKET_PAGE_SIZE; offset < total && offsets.length < MARKET_BREADTH_MAX_PAGES; offset += THS_MARKET_PAGE_SIZE) {
      offsets.push(offset);
    }
    const rest = await mapWithLimit(offsets, options.concurrency, (offset) =>
      client.marketSnapshotPage(offset, THS_MARKET_PAGE_SIZE),
    );
    const rows = [first, ...rest].flatMap((page) => page.items);
    const point = buildBreadthPoint(rows, first.timestamp, hs300);
    const points = breadthPointsOf(previous);
    if (points.length > 0 && points[points.length - 1]?.ts === point.ts) points[points.length - 1] = point;
    else points.push(point);
    return storePayload(
      "ths_breadth",
      {
        total: point.total,
        sampled: point.sampled,
        pages: 1 + offsets.length,
        up: point.up,
        down: point.down,
        flat: point.flat,
        unknown: point.unknown,
        bins: point.bins,
        markets: point.markets,
        points: points.slice(-100),
        hs300: [...hs300],
      },
      first.timestamp,
    );
  };

  const execute = async (task: ThsTaskId): Promise<number> => {
    switch (task) {
      case "index_snapshot":
        return quoteTask("index");
      case "stock_snapshot":
        return quoteTask("stock");
      case "limit_up_pool":
      case "limit_down_pool":
      case "limit_break_pool": {
        const name = task === "limit_up_pool" ? "limit-up-pool" : task === "limit_down_pool" ? "limit-down-pool" : "limit-break-pool";
        const pool = await pagedPool(name);
        return storePayload(taskKind(task) as string, pool.data, pool.timestamp);
      }
      case "limit_up_ladder":
        return storePayload(taskKind(task) as string, await client.limitUpLadder(), null);
      case "hot_stock_hour":
        return storePayload(taskKind(task) as string, await client.hotStock("hour"), null);
      case "hot_stock_day":
        return storePayload(taskKind(task) as string, await client.hotStock("day"), null);
      case "skyrocket_day":
        return storePayload(taskKind(task) as string, await client.skyrocket("day"), null);
      case "anomaly_list":
        return storePayload(taskKind(task) as string, await client.anomalyList(), null);
      case "dragon_tiger":
        return storePayload(taskKind(task) as string, await client.dragonTiger(), null);
      case "auction_benchmark":
        return storePayload(taskKind(task) as string, await client.auctionBenchmark(), null);
      case "auction_live":
      case "auction_final": {
        const stage = task === "auction_live" ? "live" : "final";
        const codes = targetsFor(task).map((t) => t.thscode).slice(0, THS_BATCH_SIZE);
        return storePayload(`ths_auction_${stage}`, await client.auctionSnapshot(codes, stage), null);
      }
      case "industry_board":
        return industryTask();
      case "breadth":
        return breadthTask();
    }
  };

  const runOne = async (task: ThsTaskId): Promise<ThsTaskOutcome> => {
    if (stopped) return { task, status: "skipped", persisted: 0, error: `skipped after ${stopped}` };
    if (options.now() >= options.deadlineMs) return { task, status: "skipped", persisted: 0, error: "deadline reached" };
    if (needsTargets(task) && targetsFor(task).length === 0) {
      return { task, status: "skipped", persisted: 0, error: "no targets" };
    }
    try {
      return { task, status: "ok", persisted: await execute(task) };
    } catch (error) {
      if (error instanceof ThsError) {
        if (error.kind === "rate_limited") stopped = "rate_limited";
        if (error.kind === "auth") stopped = "auth";
        const status: ThsTaskStatus =
          error.kind === "rate_limited" ? "rate_limited" : error.kind === "auth" ? "auth" : error.kind === "not_ready" ? "not_ready" : "failed";
        log(`ths task ${task} ${status}: ${messageOf(error)}`);
        return { task, status, persisted: 0, error: messageOf(error) };
      }
      log(`ths task ${task} failed: ${messageOf(error)}`);
      return { task, status: "failed", persisted: 0, error: messageOf(error) };
    }
  };

  const tasks = await mapWithLimit(options.tasks as ThsTaskId[], options.concurrency, runOne);
  const count = (status: ThsTaskStatus) => tasks.filter((t) => t.status === status).length;
  const ok = count("ok");
  const failed = count("failed");
  const notReady = count("not_ready");
  const rateLimited = count("rate_limited") > 0;
  const authFailed = count("auth") > 0;
  const persisted = tasks.reduce((sum, t) => sum + t.persisted, 0);

  let outcome: ThsCycleOutcome;
  if (authFailed) outcome = "auth_error";
  else if (rateLimited) outcome = "rate_limited";
  else if (ok > 0) outcome = failed > 0 ? "degraded" : "ok";
  else if (failed > 0) outcome = "failed";
  else if (notReady > 0) outcome = "not_ready";
  else outcome = "idle";

  const firstError = tasks.find((t) => t.status === "failed" || t.status === "rate_limited" || t.status === "auth")?.error;
  if (ok > 0) {
    await store.recordSourceSuccess("ths");
  } else if (firstError !== undefined) {
    await store.recordSourceFailure("ths", firstError);
  }

  return { outcome, tasks, persisted, rateLimited };
}
