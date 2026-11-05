// Instantaneous trend gauge: 1-minute MA-deviation.
//
// Definition (2026-11-04, user-specified), same formula for both markets:
//   - Bar: 1-minute candle (OKX public /api/v5/market/candles; Sina
//     CN_MarketData.getKLineData scale=1 for A-shares).
//   - Base MA: MA20 on 1-minute closes (20-minute window).
//   - Per-bar deviation: dev = (close - MA20) / MA20 * 100 (%).
//   - Trend value W: time-weighted deviation over the most recent 5 bars
//     (5 minutes), weights 1,2,3,4,5 from far to near (oldest smallest,
//     newest largest): W = sum(w_i * dev_i) / sum(w_i).
//   - W_prev uses bars -9..-5 with the same weights; W - W_prev > 0 means
//     the instantaneous trend is strengthening.
// The newest candle is the forming bar, so its close is the live price and
// W moves intra-bar; it is a current-state gauge, not a confirmed close.
// A-share bars only update during trading hours (09:30-11:30, 13:00-15:00
// Beijing); outside those hours the last session's final bars are shown.

export const MA_PERIOD = 20;
export const TREND_WINDOW = 5;
export const TREND_WEIGHTS = [1, 2, 3, 4, 5] as const;

export type MaDeviationMarket = "okx" | "ashare";

export const MA_DEVIATION_SYMBOLS = [
  { symbol: "XAU", instId: "XAU-USDT-SWAP" },
  { symbol: "CL", instId: "CL-USDT-SWAP" },
  { symbol: "BZ", instId: "BZ-USDT-SWAP" },
  { symbol: "NVDA", instId: "NVDA-USDT-SWAP" },
  { symbol: "META", instId: "META-USDT-SWAP" },
  { symbol: "MU", instId: "MU-USDT-SWAP" },
  { symbol: "SNDK", instId: "SNDK-USDT-SWAP" },
  { symbol: "SKHY", instId: "SKHY-USDT-SWAP" },
  { symbol: "TSM", instId: "TSM-USDT-SWAP" },
  { symbol: "SOXL", instId: "SOXL-USDT-SWAP" },
  { symbol: "QQQ", instId: "QQQ-USDT-SWAP" },
  { symbol: "MSFT", instId: "MSFT-USDT-SWAP" },
  { symbol: "AAPL", instId: "AAPL-USDT-SWAP" },
  { symbol: "GOOGL", instId: "GOOGL-USDT-SWAP" },
  { symbol: "AMZN", instId: "AMZN-USDT-SWAP" },
  { symbol: "TSLA", instId: "TSLA-USDT-SWAP" },
  { symbol: "AMD", instId: "AMD-USDT-SWAP" },
  { symbol: "AVGO", instId: "AVGO-USDT-SWAP" },
  { symbol: "BTC", instId: "BTC-USDT-SWAP" },
  { symbol: "ETH", instId: "ETH-USDT-SWAP" },
  { symbol: "SOL", instId: "SOL-USDT-SWAP" },
  { symbol: "OKB", instId: "OKB-USDT-SWAP" },
  { symbol: "UVXY", instId: "UVXY-USDT-SWAP" },
] as const;

/**
 * Yahoo-sourced rows shown in the OKX group. VIX is an index, not an OKX
 * product, so its 1-minute bars come from Yahoo Finance's public v8 chart
 * endpoint (^VIX) — the same source the yahoo-collector already uses.
 * Same W caliber as the OKX rows; VIX only moves during US trading hours,
 * so outside those hours the row is frozen at the last session close, like
 * the A-share rows after hours.
 */
export const MA_DEVIATION_YAHOO_SYMBOLS = [{ symbol: "VIX", yahooSymbol: "^VIX" }] as const;

/**
 * A-share symbols (1-minute Sina candles). `symbol` is the 6-digit code
 * shown on the panel; `instId` is the Sina code. Note 513000 is a
 * Shanghai-listed ETF (sh513000); sz513000 returns empty from Sina.
 */
export const MA_DEVIATION_ASHARE_SYMBOLS = [
  { symbol: "600487", instId: "sh600487" },
  { symbol: "605117", instId: "sh605117" },
  { symbol: "002463", instId: "sz002463" },
  { symbol: "001309", instId: "sz001309" },
  { symbol: "588170", instId: "sh588170" },
  { symbol: "513310", instId: "sh513310" },
  { symbol: "512400", instId: "sh512400" },
  { symbol: "158072", instId: "sz158072" },
  { symbol: "159915", instId: "sz159915" },
  { symbol: "513000", instId: "sh513000" },
  { symbol: "159941", instId: "sz159941" },
  { symbol: "000001", instId: "sh000001" },
  { symbol: "399001", instId: "sz399001" },
  { symbol: "399006", instId: "sz399006" },
  { symbol: "000688", instId: "sh000688" },
] as const;

export const SINA_REFERER = "https://finance.sina.com.cn";
export const YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com";
export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/**
 * W only needs the newest 29 closes (MA20 seed + current 5-bar window +
 * previous 5-bar window); 40 leaves headroom for suspended/delayed bars.
 */
export const SINA_MINUTE_DATALEN = 40;
/** Same 29-bar minimum, 30 for OKX. */
export const OKX_CANDLE_LIMIT = 30;
/** A-share rows are cached in-process for this long (see loadMaDeviationBoard):
 * the TTL matches the panel's 30-second refresh. */
export const ASHARE_CACHE_TTL_MS = 30_000;

export interface MaDeviationRow {
  symbol: string;
  instId: string;
  market: MaDeviationMarket;
  /** Null when the instrument fetch failed; never NaN, so JSON round-trips safely. */
  lastClose: number | null;
  lastTs: number;
  devLatest: number | null;
  w: number | null;
  wPrev: number | null;
  wChange: number | null;
}

export interface MaDeviationGroup {
  market: MaDeviationMarket;
  /** Mean W over rows with a value; null when no row in the group has one. */
  meanW: number | null;
  /** Share of rows with W > 0 among rows with a value; null when none. */
  positiveShare: number | null;
  /** Rows in the group with a W value (the denominator of the two above). */
  count: number;
}

export interface MaDeviationBoard {
  fetchedAt: string;
  rows: MaDeviationRow[];
  /** One entry per market. OKX (24h) and A-share (session-only) are never
   * averaged together: their update cadences differ, so a mixed mean would
   * compare a live price against a stale session-end value. */
  groups: MaDeviationGroup[];
}

/** Per-bar MA20 deviation in percent; null until MA_PERIOD closes exist. */
export function computeDeviations(closes: number[]): (number | null)[] {
  return closes.map((close, i) => {
    if (i + 1 < MA_PERIOD) return null;
    const window = closes.slice(i - MA_PERIOD + 1, i + 1);
    const ma = window.reduce((sum, value) => sum + value, 0) / MA_PERIOD;
    return ((close - ma) / ma) * 100;
  });
}

/** Time-weighted deviation over the last TREND_WINDOW deviations. */
export function weightedDeviation(deviations: (number | null)[]): number | null {
  const tail = deviations.slice(-TREND_WINDOW);
  if (tail.length < TREND_WINDOW || tail.some((value) => value === null)) return null;
  const weighted = tail.reduce<number>(
    (sum, value, index) => sum + (TREND_WEIGHTS[index] ?? 0) * (value ?? 0),
    0,
  );
  const weightSum = TREND_WEIGHTS.reduce((sum, value) => sum + value, 0);
  return weighted / weightSum;
}

export function buildRow(
  symbol: string,
  instId: string,
  bars: { ts: number; close: number }[],
  market: MaDeviationMarket = "okx",
): MaDeviationRow {
  const closes = bars.map((bar) => bar.close);
  const deviations = computeDeviations(closes);
  const w = weightedDeviation(deviations);
  const wPrev = weightedDeviation(deviations.slice(0, -TREND_WINDOW));
  const last = bars[bars.length - 1];
  return {
    symbol,
    instId,
    market,
    lastClose: last?.close ?? null,
    lastTs: last?.ts ?? 0,
    devLatest: deviations[deviations.length - 1] ?? null,
    w,
    wPrev,
    wChange: w !== null && wPrev !== null ? w - wPrev : null,
  };
}

function nullRow(symbol: string, instId: string, market: MaDeviationMarket): MaDeviationRow {
  return {
    symbol,
    instId,
    market,
    lastClose: null,
    lastTs: 0,
    devLatest: null,
    w: null,
    wPrev: null,
    wChange: null,
  };
}

async function fetchOkxCandles(
  instId: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ts: number; close: number }[]> {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1m&limit=${OKX_CANDLE_LIMIT}`;
  const response = await fetcher(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`OKX ${instId} returned HTTP ${response.status}`);
  const data = (await response.json()) as { code?: string; data?: string[][]; msg?: string };
  if (data.code !== "0" || !Array.isArray(data.data)) {
    throw new Error(`OKX ${instId} returned ${data.code ?? "unknown"}: ${data.msg ?? ""}`);
  }
  return data.data
    .map((row) => ({ ts: Number(row[0]), close: Number(row[4]) }))
    .filter((bar) => Number.isFinite(bar.ts) && Number.isFinite(bar.close))
    .sort((a, b) => a.ts - b.ts);
}

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
const SINA_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Parse a Sina 1-minute K-line JSONP payload. The response is a
 * `/*<script>...</script>*\/` comment followed by
 * `var=([{day, open, high, low, close, volume, amount}, ...])`, where `day`
 * is a Beijing-time string. Rows with a bad timestamp or a non-finite close
 * are dropped; bars come back ascending by ts, deduplicated by ts.
 */
export function parseSinaMinuteJsonp(body: string): { ts: number; close: number }[] {
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("Sina K-line response has no JSON array");
  }
  let rows: unknown;
  try {
    rows = JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error("Sina K-line response is not valid JSON");
  }
  if (!Array.isArray(rows)) throw new Error("Sina K-line response is not an array");
  const byTs = new Map<number, { ts: number; close: number }>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const day = record.day;
    const match = typeof day === "string" ? SINA_DAY_PATTERN.exec(day) : null;
    if (match === null) continue;
    const close = Number(record.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const [year, month, date, hour, minute, second] = match.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const ts = Date.UTC(year, month - 1, date, hour, minute, second) - BEIJING_OFFSET_MS;
    if (Number.isNaN(ts)) continue;
    byTs.set(ts, { ts, close });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchSinaCandles(
  sinaCode: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ts: number; close: number }[]> {
  const url =
    `https://quotes.sina.cn/cn/api/jsonp_v2.php/var=/CN_MarketData.getKLineData` +
    `?symbol=${sinaCode}&scale=1&ma=no&datalen=${SINA_MINUTE_DATALEN}`;
  const response = await fetcher(url, {
    headers: {
      Referer: SINA_REFERER,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`Sina ${sinaCode} returned HTTP ${response.status}`);
  return parseSinaMinuteJsonp(await response.text());
}

/**
 * Parse a Yahoo v8 chart payload into ascending 1-minute bars. Only the
 * timestamp and close columns are needed here; bars with a missing or
 * non-finite close are dropped, and bars are deduplicated by ts. The
 * newest bar is the forming bar during market hours.
 */
export function parseYahooMinuteChart(payload: unknown): { ts: number; close: number }[] {
  const chart = (payload as Record<string, unknown> | null)?.chart as
    | Record<string, unknown>
    | undefined;
  const result = Array.isArray(chart?.result) ? (chart.result[0] as Record<string, unknown>) : null;
  if (result === null || result === undefined) throw new Error("Yahoo chart response has no result");
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const indicators = result.indicators as Record<string, unknown> | undefined;
  const quote = Array.isArray(indicators?.quote)
    ? (indicators.quote[0] as Record<string, unknown>)
    : null;
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  if (timestamps.length !== closes.length) {
    throw new Error("Yahoo chart timestamps do not match the close count");
  }
  const byTs = new Map<number, { ts: number; close: number }>();
  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = Number(timestamps[i]) * 1000;
    const close = Number(closes[i]);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) continue;
    byTs.set(ts, { ts, close });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchYahooCandles(
  yahooSymbol: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ts: number; close: number }[]> {
  // range=5d (not 1d): at the start of a session 1d would supply only the
  // new session's bars, leaving too few closes to seed MA20 and the previous
  // W window — VIX would have no W for roughly the first half-hour. Five
  // sessions seed them from the preceding session, the same way the
  // count-based OKX (30) and Sina (40) requests span session boundaries.
  // Only the newest 40 bars are needed (29 for W + headroom).
  const url =
    `${YAHOO_CHART_BASE_URL}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    `?range=5d&interval=1m&includePrePost=false`;
  const response = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": YAHOO_USER_AGENT },
  });
  if (!response.ok) throw new Error(`Yahoo ${yahooSymbol} returned HTTP ${response.status}`);
  return parseYahooMinuteChart(await response.json()).slice(-40);
}

function summarizeGroup(market: MaDeviationMarket, rows: MaDeviationRow[]): MaDeviationGroup {
  const withW = rows.filter((row) => row.market === market && row.w !== null);
  return {
    market,
    meanW:
      withW.length > 0
        ? withW.reduce((sum, row) => sum + (row.w as number), 0) / withW.length
        : null,
    positiveShare:
      withW.length > 0 ? withW.filter((row) => (row.w as number) > 0).length / withW.length : null,
    count: withW.length,
  };
}

function orderGroup(rows: MaDeviationRow[]): MaDeviationRow[] {
  const ranked = rows
    .filter((row) => row.w !== null)
    .sort((a, b) => (b.w as number) - (a.w as number));
  const failed = rows.filter((row) => row.w === null);
  return [...ranked, ...failed];
}

/**
 * In-process cache for the A-share rows only. The TTL equals the panel's
 * 30-second refresh so A-share rows can move on every poll during trading
 * hours: Sina's forming 1-minute bar updates intra-minute, so its close —
 * and therefore W — can change between two consecutive polls. Outside
 * trading hours the rows are frozen at the session-end values regardless of
 * the TTL. OKX is never cached: it trades 24h and its forming bar moves
 * every refresh. The cache is keyed by fetcher identity, so a fresh fetcher
 * (e.g. in tests) always fetches.
 */
let ashareCache: { fetcher: typeof fetch; rows: MaDeviationRow[]; atMs: number } | null = null;

async function loadAshareRows(fetcher: typeof fetch): Promise<MaDeviationRow[]> {
  const now = Date.now();
  if (
    ashareCache !== null &&
    ashareCache.fetcher === fetcher &&
    now - ashareCache.atMs < ASHARE_CACHE_TTL_MS
  ) {
    return ashareCache.rows;
  }
  // Stamp the cache at fetch start, not at completion: the panel polls on a
  // fixed 30-second interval, so a stamp taken after a slow Sina fetch
  // would still be fresh at the next poll and every other poll would reuse
  // stale rows. With the start stamp, the next poll is always at least one
  // full TTL past it and refetches.
  const startedAtMs = Date.now();
  const rows = await Promise.all(
    MA_DEVIATION_ASHARE_SYMBOLS.map(async ({ symbol, instId }) => {
      try {
        const bars = await fetchSinaCandles(instId, fetcher);
        return buildRow(symbol, instId, bars, "ashare");
      } catch {
        return nullRow(symbol, instId, "ashare");
      }
    }),
  );
  ashareCache = { fetcher, rows, atMs: startedAtMs };
  return rows;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * order. OKX's public market-data endpoints allow 20 requests per 2 seconds
 * per IP; firing one request per symbol in a single burst (22 symbols now)
 * risks 429s, so the OKX fan-out below is capped well under that.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function loadMaDeviationBoard(
  fetcher: typeof fetch = fetch,
): Promise<MaDeviationBoard> {
  const [okxRows, ashareRows, yahooRows] = await Promise.all([
    mapWithConcurrency(MA_DEVIATION_SYMBOLS, 10, async ({ symbol, instId }) => {
      try {
        const bars = await fetchOkxCandles(instId, fetcher);
        return buildRow(symbol, instId, bars, "okx");
      } catch {
        return nullRow(symbol, instId, "okx");
      }
    }),
    loadAshareRows(fetcher),
    Promise.all(
      MA_DEVIATION_YAHOO_SYMBOLS.map(async ({ symbol, yahooSymbol }) => {
        try {
          const bars = await fetchYahooCandles(yahooSymbol, fetcher);
          return buildRow(symbol, yahooSymbol, bars, "okx");
        } catch {
          return nullRow(symbol, yahooSymbol, "okx");
        }
      }),
    ),
  ]);
  const rows = [...orderGroup([...okxRows, ...yahooRows]), ...orderGroup(ashareRows)];
  return {
    fetchedAt: new Date().toISOString(),
    rows,
    groups: [summarizeGroup("okx", rows), summarizeGroup("ashare", rows)],
  };
}
