import type { Metadata } from "next";
import { MaDeviationBoard } from "@/src/components/dashboard/MaDeviationBoard";
import { ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { loadMaDeviationBoard } from "@/src/modules/ma-deviation";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";

const panel = requirePanel("ma-deviation");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function MaDeviationPage() {
  const board = await loadPanelData("ma-deviation", loadMaDeviationBoard);

  return (
    <PanelFrame
      title={panel.title}
      subtitle="OKX 永续与 A 股 1 分钟 K 线：价格相对 1 分钟 MA20（20 分钟窗口）的偏离值，取最近 5 根（5 分钟）按时间权重 1、2、3、4、5（远到近递增）加权，得到瞬时趋势值 W；本页每 30 秒自动刷新"
    >
      {!board.ok ? (
        <ErrorState message={board.message} />
      ) : (
        <MaDeviationBoard initialBoard={board.data} />
      )}
    </PanelFrame>
  );
}
