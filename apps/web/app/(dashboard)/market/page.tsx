import type { Metadata } from "next";
import { MarketBoard } from "@/src/components/dashboard/MarketBoard";
import { EmptyState, ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { loadMarketBoard } from "@/src/modules/market/query";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";

const panel = requirePanel("market");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function MarketPage() {
  const board = await loadPanelData("market", loadMarketBoard);
  const empty =
    board.ok &&
    board.data.industryUp.length === 0 &&
    board.data.industryDown.length === 0 &&
    board.data.breadth === null;

  return (
    <PanelFrame
      title={panel.title}
      subtitle="同花顺行业指数涨跌榜与全市场涨跌分布（北京时间）；资金流向暂无 THS 数据源，未接入"
    >
      {!board.ok ? (
        <ErrorState message={board.message} />
      ) : empty ? (
        <EmptyState title="暂无市场数据" hint="采集器会在下一个交易日盘中写入行业榜与宽度数据。" />
      ) : (
        <MarketBoard board={board.data} />
      )}
    </PanelFrame>
  );
}
