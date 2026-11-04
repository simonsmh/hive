// OKX 1-minute MA-deviation instantaneous trend gauge.
//
// Definition (2026-11-04, user-specified):
//   - Bar: 1-minute OKX candle (public /api/v5/market/candles).
//   - Base MA: MA20 on 1-minute closes (20-minute window).
//   - Per-bar deviation: dev = (close - MA20) / MA20 * 100 (%).
//   - Trend value W: time-weighted deviation over the most recent 5 bars
//     (5 minutes), weights 1,2,3,4,5 from far to near (oldest smallest,
//     newest largest): W = sum(w_i * dev_i) / sum(w_i).
//   - W_prev uses bars -9..-5 with the same weights; W - W_prev > 0 means
//     the instantaneous trend is strengthening.
// The newest candle is the forming bar, so its close is the live price and
// W moves intra-bar; it is a current-state gauge, not a confirmed close.

export const MA_PERIOD = 20;
export const TREND_WINDOW = 5;
export const TREND_WEIGHTS = [1, 2, 3, 4, 5] as const;

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
] as const;

export interface MaDeviationRow {
  symbol: string;
  instId: string;
  lastClose: number;
  lastTs: number;
  devLatest: number | null;
  w: number | null;
  wPrev: number | null;
  wChange: number | null;
}

export interface MaDeviationBoard {
  fetchedAt: string;
  rows: MaDeviationRow[];
  meanW: number | null;
  positiveShare: number | null;
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
): MaDeviationRow {
  const closes = bars.map((bar) => bar.close);
  const deviations = computeDeviations(closes);
  const w = weightedDeviation(deviations);
  const wPrev = weightedDeviation(deviations.slice(0, -TREND_WINDOW));
  const last = bars[bars.length - 1];
  return {
    symbol,
    instId,
    lastClose: last?.close ?? NaN,
    lastTs: last?.ts ?? 0,
    devLatest: deviations[deviations.length - 1] ?? null,
    w,
    wPrev,
    wChange: w !== null && wPrev !== null ? w - wPrev : null,
  };
}

async function fetchOkxCandles(
  instId: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ts: number; close: number }[]> {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1m&limit=100`;
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

export async function loadMaDeviationBoard(
  fetcher: typeof fetch = fetch,
): Promise<MaDeviationBoard> {
  const rows = await Promise.all(
    MA_DEVIATION_SYMBOLS.map(async ({ symbol, instId }) => {
      try {
        const bars = await fetchOkxCandles(instId, fetcher);
        return buildRow(symbol, instId, bars);
      } catch {
        return {
          symbol,
          instId,
          lastClose: NaN,
          lastTs: 0,
          devLatest: null,
          w: null,
          wPrev: null,
          wChange: null,
        } satisfies MaDeviationRow;
      }
    }),
  );
  const ranked = rows
    .filter((row) => row.w !== null)
    .sort((a, b) => (b.w as number) - (a.w as number));
  const failed = rows.filter((row) => row.w === null);
  const ordered = [...ranked, ...failed];
  const withW = ranked;
  return {
    fetchedAt: new Date().toISOString(),
    rows: ordered,
    meanW:
      withW.length > 0
        ? withW.reduce((sum, row) => sum + (row.w as number), 0) / withW.length
        : null,
    positiveShare:
      withW.length > 0 ? withW.filter((row) => (row.w as number) > 0).length / withW.length : null,
  };
}
