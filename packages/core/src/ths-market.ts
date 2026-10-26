import { directionOf, isThsCode, itemsOf } from "./ths.js";

/**
 * Pure helpers for the market board: the breadth histogram and the industry
 * board. Both are derived from data the THS collector already fetches, so no
 * new upstream endpoint is needed. The one thing THS does not expose here is
 * investor-type fund flow (institution/main/large/retail); that cannot be
 * derived from price snapshots and is deliberately not approximated.
 */

/** Histogram bins, one per integer percent. Bin k counts pct in [k, k+1). */
export const BREADTH_BIN_MIN = -10;
export const BREADTH_BIN_MAX = 10;
export const BREADTH_BIN_COUNT = BREADTH_BIN_MAX - BREADTH_BIN_MIN + 1;

export function breadthBin(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return Math.min(BREADTH_BIN_MAX, Math.max(BREADTH_BIN_MIN, Math.floor(pct)));
}

export type BreadthMarket = "all" | "sh" | "sz" | "bj" | "gem" | "star" | "hs300";

export const BREADTH_MARKETS: readonly BreadthMarket[] = ["all", "sh", "sz", "bj", "gem", "star", "hs300"];

/** Markets a stock belongs to, derived from its thscode alone. */
export function marketsOf(thscode: string, hs300: ReadonlySet<string>): BreadthMarket[] {
  const markets: BreadthMarket[] = ["all"];
  const [digits = "", suffix = ""] = thscode.split(".");
  if (suffix === "SH") {
    markets.push("sh");
    if (digits.startsWith("688")) markets.push("star");
  } else if (suffix === "SZ") {
    markets.push("sz");
    if (digits.startsWith("300")) markets.push("gem");
  } else if (suffix === "BJ") {
    markets.push("bj");
  }
  if (hs300.has(thscode)) markets.push("hs300");
  return markets;
}

export interface BreadthMarketCounts {
  total: number;
  up: number;
  down: number;
  flat: number;
  unknown: number;
  /** Length BREADTH_BIN_COUNT, index i is bin (BREADTH_BIN_MIN + i). */
  bins: number[];
}

export interface BreadthPoint {
  ts: number;
  total: number;
  sampled: number;
  up: number;
  down: number;
  flat: number;
  unknown: number;
  bins: number[];
  markets: Record<BreadthMarket, BreadthMarketCounts>;
}

function emptyMarketCounts(): BreadthMarketCounts {
  return { total: 0, up: 0, down: 0, flat: 0, unknown: 0, bins: Array.from({ length: BREADTH_BIN_COUNT }, () => 0) };
}

function finitePct(row: Record<string, unknown>): number | null {
  const value = row.price_change_ratio_pct;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codeOf(row: Record<string, unknown>): string {
  return typeof row.thscode === "string" ? row.thscode.trim().toUpperCase() : "";
}

/** One breadth point from a full-market snapshot page set. */
export function buildBreadthPoint(rows: readonly Record<string, unknown>[], ts: number, hs300: ReadonlySet<string>): BreadthPoint {
  const markets = Object.fromEntries(BREADTH_MARKETS.map((market) => [market, emptyMarketCounts()])) as Record<
    BreadthMarket,
    BreadthMarketCounts
  >;
  const point: BreadthPoint = {
    ts,
    total: rows.length,
    sampled: rows.length,
    up: 0,
    down: 0,
    flat: 0,
    unknown: 0,
    bins: Array.from({ length: BREADTH_BIN_COUNT }, () => 0),
    markets,
  };
  for (const row of rows) {
    const direction = directionOf(row);
    const pct = finitePct(row);
    const bin = breadthBin(pct);
    point[direction] += 1;
    if (bin !== null) {
      const index = bin - BREADTH_BIN_MIN;
      point.bins[index] = (point.bins[index] ?? 0) + 1;
    }
    for (const market of marketsOf(codeOf(row), hs300)) {
      const counts = markets[market] as BreadthMarketCounts;
      counts.total += 1;
      counts[direction] += 1;
      if (bin !== null) {
        const index = bin - BREADTH_BIN_MIN;
        counts.bins[index] = (counts.bins[index] ?? 0) + 1;
      }
    }
  }
  return point;
}

// --- Industry board ---

export interface IndustryEntry {
  thscode: string;
  name: string;
  price: number | null;
  pct: number | null;
}

const NAME_KEYS = ["name", "index_name", "ths_name", "short_name", "display_name"];
const CODE_KEYS = ["thscode", "index_code", "ths_code", "code"];

function stringField(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * Industry catalog rows. The catalog shape is not verified against a live
 * response, so code/name are read from several candidate keys and rows
 * without a plausible index code are dropped.
 */
export function parseIndustryCatalog(data: unknown): Array<{ thscode: string; name: string }> {
  let rows: Record<string, unknown>[];
  try {
    rows = itemsOf(data);
  } catch {
    if (!Array.isArray(data)) return [];
    rows = data.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  }
  const seen = new Set<string>();
  const catalog: Array<{ thscode: string; name: string }> = [];
  for (const row of rows) {
    const thscode = stringField(row, CODE_KEYS).toUpperCase();
    if (!isThsCode(thscode) || seen.has(thscode)) continue;
    seen.add(thscode);
    catalog.push({ thscode, name: stringField(row, NAME_KEYS) });
  }
  return catalog;
}

/** Join catalog names onto snapshot rows. Snapshot codes come only from the catalog, so this is an intersection. */
export function buildIndustryEntries(
  catalog: readonly { thscode: string; name: string }[],
  snapshotItems: readonly Record<string, unknown>[],
): IndustryEntry[] {
  const names = new Map(catalog.map((row) => [row.thscode, row.name]));
  const entries: IndustryEntry[] = [];
  for (const item of snapshotItems) {
    const thscode = codeOf(item);
    if (!isThsCode(thscode)) continue;
    const price = typeof item.last_price === "number" && Number.isFinite(item.last_price) ? item.last_price : null;
    entries.push({
      thscode,
      name: names.get(thscode) || stringField(item, NAME_KEYS) || thscode,
      price,
      pct: finitePct(item),
    });
  }
  return entries;
}

/** One industry snapshot point, kept only to derive the 5-minute speed. */
export interface IndustryHistoryPoint {
  ts: number;
  prices: Record<string, number>;
}

/** Window (ms) around "5 minutes ago" that a history point must fall in to serve as the speed reference. */
export const SPEED_REF_MIN_AGE_MS = 4 * 60_000;
export const SPEED_REF_MAX_AGE_MS = 6 * 60_000;
export const INDUSTRY_HISTORY_KEEP_MS = 10 * 60_000;

export interface IndustrySpeed {
  thscode: string;
  /** Percent change versus the reference point, or null when no reference exists yet. */
  speedPct: number | null;
  refTs: number | null;
}

/**
 * 5-minute speed: current price versus the history point nearest to 5 minutes
 * ago (accepted when 4-6 minutes old, matching the 2-minute tick cadence).
 * Returns an empty array until a reference point exists, instead of inventing
 * a speed from a too-recent point.
 */
export function computeIndustrySpeed(
  history: readonly IndustryHistoryPoint[],
  current: ReadonlyMap<string, number>,
  nowTs: number,
): IndustrySpeed[] {
  const candidates = history.filter(
    (point) => nowTs - point.ts >= SPEED_REF_MIN_AGE_MS && nowTs - point.ts <= SPEED_REF_MAX_AGE_MS,
  );
  if (candidates.length === 0) return [];
  const ref = candidates.reduce((best, point) => (Math.abs(nowTs - 300_000 - point.ts) < Math.abs(nowTs - 300_000 - best.ts) ? point : best));
  const speeds: IndustrySpeed[] = [];
  for (const [thscode, price] of current) {
    const old = ref.prices[thscode];
    speeds.push({
      thscode,
      speedPct: old !== undefined && old > 0 ? ((price - old) / old) * 100 : null,
      refTs: ref.ts,
    });
  }
  return speeds;
}

export function pruneIndustryHistory(points: readonly IndustryHistoryPoint[], nowTs: number): IndustryHistoryPoint[] {
  return points.filter((point) => nowTs - point.ts <= INDUSTRY_HISTORY_KEEP_MS);
}

/** Extract a validated history array from a stored ths_industry payload, tolerating old shapes. */
export function historyOf(payload: unknown): IndustryHistoryPoint[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const history = (data as { history?: unknown }).history;
  if (!Array.isArray(history)) return [];
  return history.filter(
    (point): point is IndustryHistoryPoint =>
      typeof point === "object" &&
      point !== null &&
      typeof (point as { ts?: unknown }).ts === "number" &&
      typeof (point as { prices?: unknown }).prices === "object" &&
      (point as { prices?: unknown }).prices !== null,
  );
}

/** Extract a validated breadth points array from a stored ths_breadth payload, tolerating the old counts-only shape. */
export function breadthPointsOf(payload: unknown): BreadthPoint[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const points = (data as { points?: unknown }).points;
  if (!Array.isArray(points)) return [];
  return points.filter(
    (point): point is BreadthPoint =>
      typeof point === "object" && point !== null && typeof (point as { ts?: unknown }).ts === "number",
  );
}

/** Extract cached HS300 constituent codes from a stored ths_breadth payload. */
export function hs300Of(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const codes = (data as { hs300?: unknown }).hs300;
  if (!Array.isArray(codes)) return [];
  return codes.filter((code): code is string => typeof code === "string" && isThsCode(code.toUpperCase())).map((code) => code.toUpperCase());
}

/** Constituent codes from an index-constituents response, tolerating unknown row shapes. */
export function parseConstituents(data: unknown): string[] {
  let rows: Record<string, unknown>[];
  try {
    rows = itemsOf(data);
  } catch {
    if (!Array.isArray(data)) return [];
    rows = data.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  }
  const codes: string[] = [];
  for (const row of rows) {
    const code = stringField(row, [...CODE_KEYS, "stock_thscode", "stock_code"]).toUpperCase();
    if (isThsCode(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}
