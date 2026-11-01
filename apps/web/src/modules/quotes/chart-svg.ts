import { priceRange, smaSeries } from "./chart-math";
import type { CandleBar } from "./mapper";

/**
 * Server-side chart data for GET /api/chart.
 *
 * The route reads only the candles table (plus quotes_latest for a latest-price
 * annotation) and never calls a market upstream, so a chart can only show what the
 * collectors have already landed. This module is pure string/number work: no DOM,
 * no canvas, no native image dependency. The first version outputs SVG only; PNG
 * rasterisation is a separate decision, not smuggled in here.
 */

export const CHART_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#65a30d",
] as const;

export const MAX_MA_PERIODS = 8;
export const MAX_MA_PERIOD = 500;

/** Parses the `ma` query param ("5,10,20,60"). Throws on anything malformed. */
export function parseMaPeriods(raw: string | null): number[] {
  if (raw === null || raw.trim() === "") return [];
  const periods: number[] = [];
  for (const part of raw.split(",")) {
    const text = part.trim();
    if (!/^\d+$/.test(text)) throw new Error(`ma period "${text}" must be a positive integer`);
    const period = Number(text);
    if (period < 1 || period > MAX_MA_PERIOD) {
      throw new Error(`ma period must be between 1 and ${MAX_MA_PERIOD}`);
    }
    if (!periods.includes(period)) periods.push(period);
  }
  if (periods.length > MAX_MA_PERIODS) {
    throw new Error(`at most ${MAX_MA_PERIODS} ma periods per request`);
  }
  return periods;
}

/**
 * Rescales a series so its first close is 100, for multi-symbol strength
 * comparison. Returns null when the first close cannot anchor the scale
 * (non-finite or <= 0); the route then reports that symbol as missing rather
 * than drawing a wrong chart. SMA commutes with this linear rescale, so moving
 * averages computed on normalized bars match normalized moving averages.
 */
export function normalizeBars(bars: readonly CandleBar[]): CandleBar[] | null {
  if (bars.length === 0) return null;
  const first = bars[0]!.close;
  if (!Number.isFinite(first) || first <= 0) return null;
  const factor = 100 / first;
  return bars.map((bar) => ({
    ...bar,
    open: bar.open * factor,
    high: bar.high * factor,
    low: bar.low * factor,
    close: bar.close * factor,
  }));
}

export interface ChartSeriesInput {
  symbol: string;
  /** Bars already in display units (raw, or normalized when normalize=true). */
  bars: readonly CandleBar[];
  ma: readonly { period: number; values: readonly (number | null)[] }[];
}

export interface SeriesSummary {
  symbol: string;
  count: number;
  first_ts: string | null;
  last_ts: string | null;
  first_close: number;
  last_close: number;
  change_pct: number;
  ma_last: Record<string, number | null>;
}

/** First/last closes and change are always in the caller's raw price units. */
export function summarizeSeries(
  symbol: string,
  rawBars: readonly CandleBar[],
  maPeriods: readonly number[],
): SeriesSummary {
  const first = rawBars[0]!;
  const last = rawBars[rawBars.length - 1]!;
  const maLast: Record<string, number | null> = {};
  for (const period of maPeriods) {
    const series = smaSeries(rawBars, period);
    maLast[String(period)] = series.length > 0 ? series[series.length - 1]! : null;
  }
  return {
    symbol,
    count: rawBars.length,
    first_ts: new Date(first.time).toISOString(),
    last_ts: new Date(last.time).toISOString(),
    first_close: first.close,
    last_close: last.close,
    change_pct: ((last.close - first.close) / first.close) * 100,
    ma_last: maLast,
  };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Dash patterns keyed by the MA period's position, so MA5 vs MA60 stay distinct. */
export const MA_DASH_PATTERNS = ["6 3", "2 2", "10 4 2 4", "1 4", "12 3 3 3", "4 4", "8 2 2 2", "3 1"] as const;

/**
 * Tick precision derived from the tick spacing (span / 4), not from the price
 * level: a low-priced series such as 0.000010–0.000012 still gets distinct
 * labels instead of five copies of "0.000".
 */
function formatTick(value: number, span: number): string {
  const spacing = span / 4;
  if (!(spacing > 0)) return value.toFixed(2);
  if (spacing >= 100) return value.toFixed(0);
  if (spacing >= 10) return value.toFixed(1);
  if (spacing >= 1) return value.toFixed(2);
  const decimals = Math.min(12, Math.ceil(-Math.log10(spacing)) + 1);
  return value.toFixed(decimals);
}

function formatDateLabel(time: number, interval: string): string {
  const iso = new Date(time).toISOString();
  return interval === "1D" ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

/**
 * SVG elements for one series: polylines per contiguous non-null run, plus a
 * circle marker when a run is a single point (limit=1, or exactly one MA value
 * surviving warm-up) — a zero-length polyline with a butt cap is invisible,
 * so a lone point would otherwise vanish from the chart.
 */
function pointsFor(
  bars: readonly CandleBar[],
  values: readonly (number | null)[],
  timeIndex: Map<number, number>,
  timeCount: number,
  plot: { left: number; top: number; width: number; height: number },
  range: { min: number; max: number },
  strokeAttrs: string,
  pointFill: string,
): string[] {
  // Split on nulls so a moving average never draws a line across its warm-up gap.
  const elements: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length >= 2) {
      elements.push(`<polyline points="${current.join(" ")}" ${strokeAttrs}/>`);
    } else if (current.length === 1) {
      const [x, y] = current[0]!.split(",");
      elements.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${pointFill}"/>`);
    }
    current = [];
  };
  for (let i = 0; i < bars.length; i++) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(value)) {
      flush();
      continue;
    }
    const slot = timeIndex.get(bars[i]!.time) ?? 0;
    const x = plot.left + (timeCount <= 1 ? plot.width / 2 : (slot / (timeCount - 1)) * plot.width);
    const y = plot.top + ((range.max - value) / (range.max - range.min)) * plot.height;
    current.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  flush();
  return elements;
}

export interface BuildChartSvgInput {
  series: readonly ChartSeriesInput[];
  interval: string;
  normalize: boolean;
  width?: number;
  height?: number;
}

/**
 * Builds one SVG with one polyline per series (plus one dashed polyline per
 * requested moving average, in the series color). The x axis is the union of all
 * series timestamps, so series of different lengths stay on a shared calendar
 * instead of each being stretched to full width. Returns a placeholder SVG with
 * no polylines when every series is missing.
 */
export function buildChartSvg(input: BuildChartSvgInput): string {
  const width = input.width ?? 800;
  const requestedHeight = input.height ?? 420;
  // Legend wraps to extra rows instead of running off the right edge. It
  // covers one entry per series plus one entry per MA overlay, so MA periods
  // are identifiable in the standalone SVG, not just in the JSON.
  const legendItems =
    input.series.length + input.series.reduce((n, s) => n + s.ma.length, 0);
  const perRow = Math.max(1, Math.floor((width - 64 - 16) / 130));
  const legendRows = Math.max(1, Math.ceil(legendItems / perRow));
  const margin = { left: 64, right: 16, top: 20 + legendRows * 16 + 8, bottom: 28 };
  // The canvas grows with the legend instead of letting a tall legend eat the
  // plot: with a fixed 420px height, 14 symbols x 8 MAs (126 entries) pushed
  // the plot top past the bottom, made plot height negative, and rendered
  // rising prices downward, clipped outside the viewport.
  const MIN_PLOT_HEIGHT = 200;
  const height = Math.max(requestedHeight, margin.top + MIN_PLOT_HEIGHT + margin.bottom);
  const plot = {
    left: margin.left,
    top: margin.top,
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom,
  };

  if (input.series.length === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#666">No data</text></svg>`
    );
  }

  const allBars = input.series.flatMap((s) => s.bars);
  const overlays = input.series.flatMap((s) => s.ma.map((m) => m.values));
  const range = priceRange(allBars, overlays);
  if (range === null) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#666">No data</text></svg>`
    );
  }

  const times = [...new Set(allBars.map((b) => b.time))].sort((a, b) => a - b);
  const timeIndex = new Map(times.map((t, i) => [t, i] as const));
  const span = range.max - range.min;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
  );

  // Gridlines + y labels (5 ticks).
  for (let i = 0; i <= 4; i++) {
    const value = range.min + (span * i) / 4;
    const y = plot.top + ((range.max - value) / span) * plot.height;
    parts.push(
      `<line x1="${plot.left}" y1="${y.toFixed(2)}" x2="${plot.left + plot.width}" y2="${y.toFixed(2)}" stroke="#e5e5e5"/>`,
      `<text x="${plot.left - 6}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#666">${formatTick(value, span)}</text>`,
    );
  }

  // X labels: first / middle / last timestamp of the shared timeline.
  const labelSlots = times.length === 1 ? [0] : [0, Math.floor(times.length / 2), times.length - 1];
  for (const slot of new Set(labelSlots)) {
    const x = plot.left + (times.length <= 1 ? plot.width / 2 : (slot / (times.length - 1)) * plot.width);
    parts.push(
      `<text x="${x.toFixed(2)}" y="${plot.top + plot.height + 18}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#666">${formatDateLabel(times[slot]!, input.interval)}</text>`,
    );
  }

  // Legend entries are collected while drawing, then rendered in final order:
  // all symbols first, then all MA overlays, each in its own grid slot.
  interface LegendEntry {
    sample: (x: number, y: number) => string;
    label: string;
  }
  const symbolLegend: LegendEntry[] = [];
  const maLegend: LegendEntry[] = [];

  input.series.forEach((s, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length]!;
    const closes = s.bars.map((b) => b.close);
    parts.push(
      ...pointsFor(
        s.bars,
        closes,
        timeIndex,
        times.length,
        plot,
        range,
        `fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`,
        color,
      ),
    );
    s.ma.forEach((m, j) => {
      const dash = MA_DASH_PATTERNS[j % MA_DASH_PATTERNS.length]!;
      parts.push(
        ...pointsFor(
          s.bars,
          m.values,
          timeIndex,
          times.length,
          plot,
          range,
          `fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="${dash}" opacity="0.75"`,
          color,
        ),
      );
      maLegend.push({
        sample: (x, y) =>
          `<line x1="${x}" y1="${y + 6}" x2="${x + 12}" y2="${y + 6}" stroke="${color}" stroke-width="1" stroke-dasharray="${dash}"/>`,
        label: `${s.symbol} MA${m.period}`,
      });
    });
    const first = s.bars[0]!;
    const last = s.bars[s.bars.length - 1]!;
    const change = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
    symbolLegend.push({
      sample: (x, y) => `<rect x="${x}" y="${y}" width="12" height="12" fill="${color}"/>`,
      label: `${s.symbol} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`,
    });
  });
  const renderLegend = (entries: LegendEntry[], startSlot: number) => {
    const out: string[] = [];
    entries.forEach((entry, k) => {
      const slot = startSlot + k;
      const col = slot % perRow;
      const row = Math.floor(slot / perRow);
      const x = plot.left + col * 130;
      const y = 10 + row * 16;
      out.push(
        entry.sample(x, y),
        `<text x="${x + 16}" y="${y + 10}" font-family="sans-serif" font-size="12" fill="#222">${escapeXml(entry.label)}</text>`,
      );
    });
    return out;
  };
  parts.push(...renderLegend(symbolLegend, 0), ...renderLegend(maLegend, symbolLegend.length));

  if (input.normalize) {
    parts.push(
      `<text x="${plot.left + plot.width}" y="${margin.top - 4}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#666">normalized, first close = 100</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}
