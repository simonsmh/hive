"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatPrice, formatSignedPercent, formatUtcDate } from "@/src/modules/format";
import { useTopic } from "@/src/modules/live/stream-client";
import { applyLivePrice, barChangePct, smaSeries } from "@/src/modules/quotes/chart-math";
import {
  summarizeLatest,
  toCandleBars,
  type CandleBar,
  type CandleRow,
  type QuoteView,
} from "@/src/modules/quotes/mapper";
import { MA_PERIODS, ProChart, maColor } from "./ProChart";

/** Mirrors INTERVALS in @hive/core without importing the server-oriented package client-side. */
const CHART_INTERVALS = ["1m", "5m", "15m", "1H", "1D"] as const;
type ChartInterval = (typeof CHART_INTERVALS)[number];

const INTERVAL_MS: Record<ChartInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1H": 3_600_000,
  "1D": 86_400_000,
};

const INTERVAL_LIMIT: Record<ChartInterval, number> = { "1m": 480, "5m": 480, "15m": 480, "1H": 500, "1D": 500 };

const DEFAULT_MA: readonly number[] = [5, 10, 20];

interface CandlesResponse {
  candles?: unknown;
  error?: string;
}

/**
 * Interactive chart panel: server-rendered first paint from the initial bars, then
 * interval switching through /api/candles and a live tail folded in from the quote
 * stream, so the forming candle moves with the market between full refreshes.
 */
export function ChartPanel({
  symbol,
  initialBars,
  initialInterval,
}: {
  symbol: string;
  initialBars: CandleBar[];
  initialInterval: ChartInterval;
}) {
  const [interval, setInterval] = useState<ChartInterval>(initialInterval);
  const [bars, setBars] = useState<readonly CandleBar[]>(initialBars);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [enabledMa, setEnabledMa] = useState<readonly number[]>(DEFAULT_MA);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const barsIntervalRef = useRef<ChartInterval>(initialInterval);

  useEffect(() => {
    // Always bump the request id so a still-in-flight fetch for another interval
    // can never overwrite the newly selected one; skip the network round trip
    // only when the displayed bars already belong to this interval.
    const requestId = ++requestRef.current;
    if (barsIntervalRef.current === interval) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setHoverIndex(null);
    const params = new URLSearchParams({
      symbol,
      source: "okx",
      interval,
      limit: String(INTERVAL_LIMIT[interval]),
    });
    fetch(`/api/candles?${params.toString()}`)
      .then(async (response) => {
        const body = (await response.json()) as CandlesResponse;
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return toCandleBars(Array.isArray(body.candles) ? (body.candles as CandleRow[]) : []);
      })
      .then((next) => {
        if (requestRef.current !== requestId) return;
        barsIntervalRef.current = interval;
        setBars(next);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== requestId) return;
        setError(cause instanceof Error ? cause.message : "加载失败");
        setLoading(false);
      });
  }, [interval, initialInterval, symbol]);

  useTopic("quotes", (data) => {
    const quotes = (data as { quotes?: QuoteView[] } | null)?.quotes;
    const quote = quotes?.find((item) => item.symbol === symbol);
    if (!quote || quote.price === null || !quote.ts) return;
    const tsMs = Date.parse(quote.ts);
    if (!Number.isFinite(tsMs)) return;
    setBars((previous) => applyLivePrice(previous, quote.price!, tsMs, INTERVAL_MS[interval]));
  });

  const activeMa = useMemo(() => MA_PERIODS.filter((period) => enabledMa.includes(period)), [enabledMa]);
  const focus = hoverIndex !== null ? bars[hoverIndex] : bars[bars.length - 1];
  const latest = summarizeLatest(bars);
  const maValues = useMemo(() => {
    if (!focus) return [];
    const index = bars.indexOf(focus);
    return activeMa.map((period) => ({ period, value: smaSeries(bars, period)[index] ?? null }));
  }, [bars, focus, activeMa]);

  return (
    <div className="chart-panel">
      <div className="chart-toolbar">
        <nav className="chips" aria-label="选择周期">
          {CHART_INTERVALS.map((value) => (
            <button
              key={value}
              type="button"
              className="chip"
              aria-current={value === interval ? "true" : undefined}
              onClick={() => setInterval(value)}
            >
              {value}
            </button>
          ))}
        </nav>
        <div className="chips" aria-label="均线开关">
          {MA_PERIODS.map((period) => {
            const on = enabledMa.includes(period);
            return (
              <button
                key={period}
                type="button"
                className="chip chip-toggle"
                aria-pressed={on}
                aria-current={on ? "true" : undefined}
                onClick={() => setEnabledMa(on ? enabledMa.filter((p) => p !== period) : [...enabledMa, period])}
              >
                <span className="ma-swatch" style={{ background: maColor(period) }} aria-hidden="true" />
                MA{period}
              </button>
            );
          })}
        </div>
      </div>

      {latest ? (
        <div className="candle-summary">
          <strong className="price">{formatPrice(latest.close)}</strong>
          {latest.changePct === null ? null : (
            <span className={latest.changePct >= 0 ? "up" : "down"}>{formatSignedPercent(latest.changePct)}</span>
          )}
          <span className="muted">
            {formatUtcDate(latest.time)} {bars[bars.length - 1]?.confirmed ? "收盘" : "进行中"}
          </span>
          {loading ? <span className="muted">切换周期中…</span> : null}
        </div>
      ) : null}

      {error ? (
        <div className="error" role="alert">
          K 线加载失败：{error}
        </div>
      ) : bars.length === 0 ? (
        <div className="empty">
          <strong>{symbol} 暂无此周期数据</strong>
          采集函数写入该周期 K 线后会显示在这里。
        </div>
      ) : (
        <>
          <ProChart
            bars={bars}
            maPeriods={activeMa}
            intraday={interval !== "1D"}
            hoverIndex={hoverIndex}
            onHover={setHoverIndex}
          />
          {focus ? (
            <p className="chart-legend meta" aria-live="off">
              <span>{new Date(focus.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</span>
              <span>
                开 {formatPrice(focus.open)} 高 {formatPrice(focus.high)} 低 {formatPrice(focus.low)} 收{" "}
                {formatPrice(focus.close)}
              </span>
              {(() => {
                const pct = barChangePct(focus);
                return pct === null ? null : (
                  <span className={pct >= 0 ? "up" : "down"}>{formatSignedPercent(pct)}</span>
                );
              })()}
              <span>量 {focus.volume > 0 ? focus.volume.toLocaleString("zh-CN") : "—"}</span>
              {maValues.map(({ period, value }) =>
                value === null ? null : (
                  <span key={period} style={{ color: maColor(period) }}>
                    MA{period} {formatPrice(value)}
                  </span>
                ),
              )}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
