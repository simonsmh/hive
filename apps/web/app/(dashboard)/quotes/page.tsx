import type { Metadata } from "next";
import Link from "next/link";
import { ChartPanel } from "@/src/components/dashboard/ChartPanel";
import { LiveQuoteList } from "@/src/components/dashboard/LiveQuoteList";
import { EmptyState, ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";
import { buildQuoteBoard, resolveSelectedSymbol, toCandleBars, type QuoteView } from "@/src/modules/quotes/mapper";
import { loadCandles, loadEnabledSymbols, loadLatestQuotes } from "@/src/modules/quotes/query";

const panel = requirePanel("quotes");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

const INITIAL_INTERVAL = "1D" as const;
const INITIAL_BARS = 180;

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
    <PanelFrame title={panel.title} subtitle="OKX 永续合约，红涨绿跌（北京时间）；报价与 K 线实时更新">
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
  const candles = await loadPanelData(`candles ${selected}`, async () =>
    toCandleBars(await loadCandles(selected, INITIAL_INTERVAL, INITIAL_BARS)),
  );

  return (
    <div className="quotes-layout">
      <section aria-label="最新报价">
        <LiveQuoteList initial={quotes} />
      </section>

      <section className="quotes-chart" aria-label="K 线走势">
        <h2>K 线走势</h2>
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

        {candles.ok ? (
          <ChartPanel key={selected} symbol={selected} initialBars={candles.data} initialInterval={INITIAL_INTERVAL} />
        ) : (
          <ErrorState message={candles.message} />
        )}
      </section>
    </div>
  );
}
