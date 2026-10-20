import type { Metadata } from "next";
import { PanelFrame, ErrorState } from "@/src/components/dashboard/PanelFrame";
import { TrendManager } from "@/src/components/dashboard/TrendManager";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";
import { listTrendViews } from "@/src/modules/trend/query";

const panel = requirePanel("trend");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function TrendPage() {
  const strategies = await loadPanelData("trend_strategies", listTrendViews);
  return (
    <PanelFrame
      title={panel.title}
      subtitle="全机械趋势跟随：六道闸门全过才开仓，ATR 步长金字塔加仓，统一止损锁定全仓风险，ATR 衰减或反穿 MA60 退出。评估器每 3 分钟一轮，影子实例只模拟不下单，实盘下单走 order-submit 全部风控闸门。"
    >
      {strategies.ok ? <TrendManager initialStrategies={strategies.data} /> : <ErrorState message={strategies.message} />}
    </PanelFrame>
  );
}
