"use client";

import { useEffect, useRef, useState } from "react";
import { formatPrice } from "@/src/modules/format";
import { barIndexAtX, maxVolume, priceRange, smaSeries } from "@/src/modules/quotes/chart-math";
import type { CandleBar } from "@/src/modules/quotes/mapper";

const AXIS_WIDTH = 58;
const AXIS_HEIGHT = 20;
const TOP_PAD = 6;
const PANE_GAP = 8;
const VOLUME_RATIO = 0.22;
const MA_COLORS = ["#d97706", "#0284c7", "#9333ea", "#0d9488"];
export const MA_PERIODS = [5, 10, 20, 60] as const;

interface Palette {
  up: string;
  down: string;
  border: string;
  muted: string;
  text: string;
  accent: string;
  surface: string;
}

function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    up: get("--up", "#dc2626"),
    down: get("--down", "#16a34a"),
    border: get("--border", "#e5e0d0"),
    muted: get("--muted", "#6b6255"),
    text: get("--text", "#1f1a12"),
    accent: get("--accent", "#d97706"),
    surface: get("--surface", "#ffffff"),
  };
}

function formatAxisTime(timeMs: number, intraday: boolean): string {
  const date = new Date(timeMs);
  if (intraday) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(date);
}

/**
 * Canvas candlestick chart: price pane with moving averages and a last-price line,
 * volume pane below, crosshair with axis tags. Red is up and green is down (CN
 * convention). All geometry comes from the pure helpers in chart-math.ts.
 */
export function ProChart({
  bars,
  maPeriods,
  intraday,
  hoverIndex,
  onHover,
  height = 340,
}: {
  bars: readonly CandleBar[];
  maPeriods: readonly number[];
  intraday: boolean;
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.floor(next));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || bars.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const palette = readPalette();
    const plotWidth = width - AXIS_WIDTH;
    const panesHeight = height - AXIS_HEIGHT - TOP_PAD;
    const priceHeight = Math.floor(panesHeight * (1 - VOLUME_RATIO));
    const volumeTop = TOP_PAD + priceHeight + PANE_GAP;
    const volumeHeight = panesHeight - priceHeight - PANE_GAP;

    const maSeries = maPeriods.map((period) => smaSeries(bars, period));
    const range = priceRange(bars, maSeries);
    if (!range) return;
    const toY = (price: number) => TOP_PAD + ((range.max - price) / (range.max - range.min)) * priceHeight;
    const slot = plotWidth / bars.length;
    const bodyWidth = Math.max(1, Math.min(15, slot * 0.62));
    const centerX = (index: number) => (index + 0.5) * slot;
    const volumeMax = maxVolume(bars);
    const toVolumeY = (volume: number) =>
      volumeMax > 0 ? volumeTop + volumeHeight - (volume / volumeMax) * volumeHeight : volumeTop + volumeHeight;

    ctx.font = "11px system-ui, sans-serif";
    ctx.lineWidth = 1;

    // Horizontal gridlines with price labels.
    ctx.strokeStyle = palette.border;
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const price = range.min + ((range.max - range.min) * i) / 4;
      const y = Math.round(toY(price)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();
      ctx.fillText(formatPrice(price), plotWidth + 6, y);
    }

    // Candles and volume bars.
    bars.forEach((bar, index) => {
      const color = bar.close >= bar.open ? palette.up : palette.down;
      const x = centerX(index);
      ctx.globalAlpha = bar.confirmed ? 1 : 0.55;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, toY(bar.high));
      ctx.lineTo(x, toY(bar.low));
      ctx.stroke();
      const top = toY(Math.max(bar.open, bar.close));
      const bottom = toY(Math.min(bar.open, bar.close));
      ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top));
      if (volumeMax > 0) {
        ctx.globalAlpha = bar.confirmed ? 0.65 : 0.35;
        const vy = toVolumeY(bar.volume);
        ctx.fillRect(x - bodyWidth / 2, vy, bodyWidth, volumeTop + volumeHeight - vy);
      }
      ctx.globalAlpha = 1;
    });

    // Moving averages.
    maSeries.forEach((series, seriesIndex) => {
      ctx.strokeStyle = MA_COLORS[seriesIndex % MA_COLORS.length]!;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      series.forEach((value, index) => {
        if (value === null) return;
        const x = centerX(index);
        const y = toY(value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    });
    ctx.lineWidth = 1;

    // Last price line and tag.
    const last = bars[bars.length - 1]!;
    const lastY = toY(last.close);
    ctx.strokeStyle = palette.accent;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(lastY) + 0.5);
    ctx.lineTo(plotWidth, Math.round(lastY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = palette.accent;
    const tagText = formatPrice(last.close);
    ctx.fillRect(plotWidth + 1, lastY - 9, AXIS_WIDTH - 2, 18);
    ctx.fillStyle = "#fff";
    ctx.fillText(tagText, plotWidth + 6, lastY);

    // Time axis labels.
    ctx.fillStyle = palette.muted;
    ctx.textBaseline = "top";
    const labelCount = Math.max(2, Math.min(5, Math.floor(plotWidth / 110)));
    for (let i = 0; i < labelCount; i++) {
      const index = Math.round((i * (bars.length - 1)) / (labelCount - 1));
      const bar = bars[index]!;
      const x = Math.min(Math.max(centerX(index) - 16, 0), plotWidth - 34);
      ctx.fillText(formatAxisTime(bar.time, intraday), x, TOP_PAD + panesHeight + 5);
    }

    // Crosshair.
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < bars.length) {
      const bar = bars[hoverIndex]!;
      const x = Math.round(centerX(hoverIndex)) + 0.5;
      ctx.strokeStyle = palette.muted;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, TOP_PAD);
      ctx.lineTo(x, TOP_PAD + panesHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = palette.text;
      const timeText = formatAxisTime(bar.time, intraday);
      ctx.fillRect(Math.min(Math.max(x - 22, 0), plotWidth - 46), TOP_PAD + panesHeight + 2, 46, 16);
      ctx.fillStyle = palette.surface;
      ctx.textAlign = "center";
      ctx.fillText(timeText, Math.min(Math.max(x, 23), plotWidth - 24), TOP_PAD + panesHeight + 5);
      ctx.textAlign = "left";
    }
  }, [bars, maPeriods, hoverIndex, width, height, intraday]);

  return (
    <div ref={wrapRef} className="pro-chart">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height }}
        role="img"
        aria-label="K 线图"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const plotWidth = rect.width - AXIS_WIDTH;
          onHover(barIndexAtX(event.clientX - rect.left, plotWidth, bars.length));
        }}
        onPointerLeave={() => onHover(null)}
      />
    </div>
  );
}

export function maColor(period: number): string {
  const index = (MA_PERIODS as readonly number[]).indexOf(period);
  return MA_COLORS[(index < 0 ? 0 : index) % MA_COLORS.length]!;
}
