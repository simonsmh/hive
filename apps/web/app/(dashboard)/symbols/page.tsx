import type { Metadata } from "next";
import { PanelFrame, ErrorState } from "@/src/components/dashboard/PanelFrame";
import { SymbolManager } from "@/src/components/dashboard/SymbolManager";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";
import { listSymbolViews } from "@/src/modules/symbols/query";

const panel = requirePanel("symbols");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function SymbolsPage() {
  const symbols = await loadPanelData("symbol_map", listSymbolViews);
  return (
    <PanelFrame
      title={panel.title}
      subtitle="采集标的完全由这张表决定：添加后采集器在下一分钟内自动跟上，删除只停采集、历史数据按保留策略过期。"
    >
      {symbols.ok ? <SymbolManager initialSymbols={symbols.data} /> : <ErrorState message={symbols.message} />}
    </PanelFrame>
  );
}
