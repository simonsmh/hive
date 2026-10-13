import type { Metadata } from "next";
import Link from "next/link";
import { CandleChart } from "@/src/components/dashboard/CandleChart";
import { EmptyState, ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { formatPrice, formatSignedPercent, formatUtcDate } from "@/src/modules/format";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";
import {
  buildQuoteBoard,
  resolveSelectedSymbol,
  summarizeLatest,
  toCandleBars,
  type CandleBar,
  type QuoteView,
} from "@/src/modules/quotes/mapper";
import { CANDLE_HISTORY, loadDailyCandles, loadEnabledSymbols, loadLatestQuotes } from "@/src/modules/quotes/query";

const panel = requirePanel("quotes");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string | string[] }>;
}) {
  const { symbol: requested } = await searchParams;
  const board = await loadPanelData("quotes", async () => {
    const symbols = await loadEnabledSymbols();
    return buildQuoteBoard(symbols, await loadLatestQuotes(symbols));
  });

  return (
    <PanelFrame title={panel.title} subtitle="OKX 永续合约最新价，红涨绿跌（北京时间）">
      {!board.ok ? (
        <ErrorState message={board.message} />
      ) : board.data.length === 0 ? (
        <EmptyState title="暂无标的" hint="symbol_map 中没有启用的标的。" />
      ) : (
        <QuoteSection quotes={board.data} requested={Array.isArray(requested) ? requested[0] : requested} />
      )}
    </PanelFrame>
  );
}

async function QuoteSection({ quotes, requested }: { quotes: QuoteView[]; requested: string | undefined }) {
  const symbols = quotes.map((quote) => quote.symbol);
  const selected = resolveSelectedSymbol(requested, symbols) ?? symbols[0] ?? "";
  const candles = await loadPanelData(`candles ${selected}`, async () => toCandleBars(await loadDailyCandles(selected)));

  return (
    <>
      <ul className="list">
        {quotes.map((quote) => (
          <li key={quote.symbol} className="quote-row">
            <strong>{quote.symbol}</strong>
            {quote.price === null ? (
              <span className="muted">暂无报价</span>
            ) : (
              <span className="price">{formatPrice(quote.price)}</span>
            )}
          </li>
        ))}
      </ul>

      <h2>日线走势（UTC 日线，最近 {CANDLE_HISTORY} 根）</h2>
      <nav className="chips" aria-label="选择标的">
        {symbols.map((symbol) => (
          <Link
            key={symbol}
            href={`/quotes?symbol=${encodeURIComponent(symbol)}`}
            className="chip"
            aria-current={symbol === selected ? "true" : undefined}
          >
            {symbol}
          </Link>
        ))}
      </nav>

      {candles.ok ? <CandleBlock symbol={selected} bars={candles.data} /> : <ErrorState message={candles.message} />}
    </>
  );
}

function CandleBlock({ symbol, bars }: { symbol: string; bars: CandleBar[] }) {
  const latest = summarizeLatest(bars);
  const first = bars[0];
  const last = bars.at(-1);
  if (!latest || !first || !last) {
    return <EmptyState title={`${symbol} 暂无日线数据`} hint="Worker 采集 1D K 线后会显示在这里。" />;
  }
  const low = Math.min(...bars.map((b) => b.low));
  const high = Math.max(...bars.map((b) => b.high));

  return (
    <>
      <div className="candle-summary">
        <strong className="price">{formatPrice(latest.close)}</strong>
        {latest.changePct === null ? null : (
          <span className={latest.changePct >= 0 ? "up" : "down"}>{formatSignedPercent(latest.changePct)}</span>
        )}
        <span className="muted">
          {formatUtcDate(latest.time)} {last.confirmed ? "收盘" : "进行中"}
        </span>
      </div>
      <CandleChart bars={bars} label={`${symbol} 最近 ${bars.length} 根日线`} />
      <div className="candle-axis">
        <span>{formatUtcDate(first.time)}</span>
        <span>
          {formatPrice(low)} – {formatPrice(high)}
        </span>
        <span>{formatUtcDate(last.time)}</span>
      </div>
    </>
  );
}
