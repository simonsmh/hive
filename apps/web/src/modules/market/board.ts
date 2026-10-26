/**
 * Pure normalization for the market board. The collector stores industry and
 * breadth rows in daily_snapshot; this module turns the latest stored rows
 * into the shape the panel renders, tolerating the old counts-only breadth
 * shape (bins/markets absent) and rows that have not been collected yet.
 */

export interface IndustryRow {
  thscode: string;
  name: string;
  price: number | null;
  pct: number | null;
}

export interface SpeedRow {
  thscode: string;
  name: string;
  speedPct: number;
}

export interface BreadthMarketCounts {
  total: number;
  up: number;
  down: number;
  flat: number;
  unknown: number;
  bins: number[] | null;
}

export interface BreadthBoard {
  ts: number | null;
  total: number;
  up: number;
  down: number;
  flat: number;
  unknown: number;
  /** 21 bins, index i is bin (-10 + i); null for the old counts-only shape. */
  bins: number[] | null;
  markets: Record<string, BreadthMarketCounts> | null;
  points: number;
}

export interface MarketBoard {
  date: string | null;
  industryUpdatedAt: string | null;
  industryUp: IndustryRow[];
  industryDown: IndustryRow[];
  speedUp: SpeedRow[];
  speedDown: SpeedRow[];
  breadth: BreadthBoard | null;
  /** Snapshot date of the breadth row, so the panel can label its session. */
  breadthDate: string | null;
  /** Snapshot date of the limit-pool rows, so a cross-session mix is visible. */
  limitsDate: string | null;
  /**
   * Limit counts are only combined with breadth when both come from the same
   * session; pool rows from another date are reported via limitsDate but
   * never mixed into today's totals.
   */
  limitUp: number | null;
  limitDown: number | null;
}

export interface SnapshotRow {
  snapshot_date: string;
  kind: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dataOf(row: SnapshotRow | undefined): Record<string, unknown> | null {
  if (!row || !isRecord(row.payload)) return null;
  const data = row.payload.data;
  return isRecord(data) ? data : null;
}

function latest(rows: readonly SnapshotRow[], kind: string): SnapshotRow | undefined {
  return rows.find((row) => row.kind === kind);
}

function parseIndustry(data: Record<string, unknown> | null): { entries: IndustryRow[]; speed: SpeedRow[] } {
  if (!data) return { entries: [], speed: [] };
  const names = new Map<string, string>();
  const entries: IndustryRow[] = [];
  if (Array.isArray(data.entries)) {
    for (const item of data.entries) {
      if (!isRecord(item) || typeof item.thscode !== "string") continue;
      const name = typeof item.name === "string" && item.name !== "" ? item.name : item.thscode;
      names.set(item.thscode, name);
      entries.push({ thscode: item.thscode, name, price: finiteOrNull(item.price), pct: finiteOrNull(item.pct) });
    }
  }
  const speed: SpeedRow[] = [];
  if (Array.isArray(data.speed)) {
    for (const item of data.speed) {
      if (!isRecord(item) || typeof item.thscode !== "string") continue;
      const speedPct = finiteOrNull(item.speedPct);
      if (speedPct === null) continue;
      speed.push({ thscode: item.thscode, name: names.get(item.thscode) ?? item.thscode, speedPct });
    }
  }
  return { entries, speed };
}

function parseMarketCounts(value: unknown): BreadthMarketCounts | null {
  if (!isRecord(value)) return null;
  const bins = Array.isArray(value.bins) && value.bins.length === 21 ? (value.bins as number[]) : null;
  const total = typeof value.total === "number" ? value.total : 0;
  return {
    total,
    up: typeof value.up === "number" ? value.up : 0,
    down: typeof value.down === "number" ? value.down : 0,
    flat: typeof value.flat === "number" ? value.flat : 0,
    unknown: typeof value.unknown === "number" ? value.unknown : 0,
    bins,
  };
}

function parseBreadth(data: Record<string, unknown> | null): BreadthBoard | null {
  if (!data) return null;
  const points = Array.isArray(data.points) ? data.points : [];
  const last = points.length > 0 ? points[points.length - 1] : null;
  const source: Record<string, unknown> = isRecord(last) ? last : data;
  const markets: Record<string, BreadthMarketCounts> = {};
  if (isRecord(source.markets)) {
    for (const [market, counts] of Object.entries(source.markets)) {
      const parsed = parseMarketCounts(counts);
      if (parsed) markets[market] = parsed;
    }
  }
  const bins = Array.isArray(source.bins) && source.bins.length === 21 ? (source.bins as number[]) : null;
  return {
    ts: finiteOrNull(source.ts),
    total: typeof source.total === "number" ? source.total : 0,
    up: typeof source.up === "number" ? source.up : 0,
    down: typeof source.down === "number" ? source.down : 0,
    flat: typeof source.flat === "number" ? source.flat : 0,
    unknown: typeof source.unknown === "number" ? source.unknown : 0,
    bins,
    markets: Object.keys(markets).length > 0 ? markets : null,
    points: points.length,
  };
}

function poolCount(data: Record<string, unknown> | null): number | null {
  if (!data || !Array.isArray(data.item)) return null;
  return data.item.length;
}

const byPctDesc = (a: IndustryRow, b: IndustryRow) => (b.pct ?? Number.NEGATIVE_INFINITY) - (a.pct ?? Number.NEGATIVE_INFINITY);
const byPctAsc = (a: IndustryRow, b: IndustryRow) => (a.pct ?? Number.POSITIVE_INFINITY) - (b.pct ?? Number.POSITIVE_INFINITY);

/** Rows must already be ordered newest-first per kind (see query.ts). */
export function buildMarketBoard(rows: readonly SnapshotRow[]): MarketBoard {
  const industryRow = latest(rows, "ths_industry");
  const breadthRow = latest(rows, "ths_breadth");
  const limitUpRow = latest(rows, "ths_limit_up_pool");
  const limitDownRow = latest(rows, "ths_limit_down_pool");
  const { entries, speed } = parseIndustry(dataOf(industryRow));
  const withPct = entries.filter((entry) => entry.pct !== null);
  const breadthDate = breadthRow?.snapshot_date ?? null;
  const limitsDate = limitUpRow?.snapshot_date ?? limitDownRow?.snapshot_date ?? null;
  const sameSession = breadthDate !== null && limitsDate === breadthDate;
  return {
    date: breadthDate ?? industryRow?.snapshot_date ?? null,
    industryUpdatedAt: industryRow && isRecord(industryRow.payload) && typeof industryRow.payload.fetched_at === "string"
      ? (industryRow.payload.fetched_at as string)
      : null,
    industryUp: [...withPct].sort(byPctDesc).slice(0, 10),
    industryDown: [...withPct].sort(byPctAsc).slice(0, 10),
    speedUp: [...speed].sort((a, b) => b.speedPct - a.speedPct).slice(0, 10),
    speedDown: [...speed].sort((a, b) => a.speedPct - b.speedPct).slice(0, 10),
    breadth: parseBreadth(dataOf(breadthRow)),
    breadthDate,
    limitsDate,
    limitUp: sameSession ? poolCount(dataOf(limitUpRow)) : null,
    limitDown: sameSession ? poolCount(dataOf(limitDownRow)) : null,
  };
}
