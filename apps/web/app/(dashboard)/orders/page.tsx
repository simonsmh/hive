import type { Metadata } from "next";
import { PanelFrame, ErrorState } from "@/src/components/dashboard/PanelFrame";
import { OrdersManager } from "@/src/components/dashboard/OrdersManager";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";
import { listOrderViews } from "@/src/modules/orders/query";

const panel = requirePanel("orders");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const orders = await loadPanelData("conditional_orders", listOrderViews);
  return (
    <PanelFrame
      title={panel.title}
      subtitle="高级挂单：回撤砸够 + 超卖先就绪，反转确认才真下单。评估器每 3 分钟评估一轮，触发经 order-submit 全部风控闸门，并推送通知。"
    >
      {orders.ok ? <OrdersManager initialOrders={orders.data} /> : <ErrorState message={orders.message} />}
    </PanelFrame>
  );
}
