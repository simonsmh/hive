import { buildCandleGeometry, type CandleBar } from "@/src/modules/quotes/mapper";

const WIDTH = 320;
const HEIGHT = 180;
const PADDING = 8;
const GRID_RATIOS = [0.25, 0.5, 0.75];

/**
 * Server-rendered SVG, so the chart ships no client JavaScript. Red marks up days and green
 * down days (CN convention). Colour comes from the `.up` / `.down` classes via currentColor.
 */
export function CandleChart({ bars, label }: { bars: readonly CandleBar[]; label: string }) {
  const geometry = buildCandleGeometry(bars, WIDTH, HEIGHT, PADDING);
  if (!geometry) return null;

  return (
    <svg className="candle-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
      {GRID_RATIOS.map((ratio) => {
        const y = PADDING + ratio * (HEIGHT - PADDING * 2);
        return <line key={ratio} className="grid" x1={0} x2={WIDTH} y1={y} y2={y} />;
      })}
      {geometry.glyphs.map((glyph, index) => {
        const bar = bars[index];
        const tone = glyph.up ? "up" : "down";
        return (
          <g key={bar?.time ?? index} className={`candle ${tone}`} opacity={bar?.confirmed === false ? 0.55 : 1}>
            <line x1={glyph.x} x2={glyph.x} y1={glyph.wickTop} y2={glyph.wickBottom} strokeWidth={1} />
            <rect
              x={glyph.x - geometry.bodyWidth / 2}
              y={glyph.bodyTop}
              width={geometry.bodyWidth}
              height={glyph.bodyHeight}
            />
          </g>
        );
      })}
    </svg>
  );
}
