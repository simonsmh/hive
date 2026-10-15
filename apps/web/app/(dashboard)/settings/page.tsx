import type { Metadata } from "next";
import { NotificationSettings } from "@/src/components/dashboard/NotificationSettings";
import { PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { requirePanel } from "@/src/modules/registry";

const panel = requirePanel("settings");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

const API_ENDPOINTS: readonly { method: string; path: string; note: string }[] = [
  { method: "GET", path: "/api/quote?symbols=MU,BTC", note: "最新报价（可多标的）" },
  { method: "GET", path: "/api/candles?symbol=MU&interval=1H&limit=500", note: "K 线，支持 1m/5m/15m/1H/1D 与 from/to" },
  { method: "GET", path: "/api/atr?symbol=MU", note: "ATR 波动指标" },
  { method: "GET", path: "/api/health", note: "数据源健康" },
  { method: "GET", path: "/api/alerts", note: "告警列表" },
  { method: "GET", path: "/api/news", note: "新闻事件与条目" },
  { method: "GET", path: "/api/stream", note: "SSE 实时流：quotes / news / alerts / health 事件" },
  { method: "GET", path: "/api/webhooks", note: "Webhook 订阅管理（另有 POST/PATCH/DELETE）" },
];

export default function SettingsPage() {
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null;

  return (
    <>
      <PanelFrame title="通知设置" subtitle="把新闻和重要告警推送到这台设备（Web Push，PWA）">
        <NotificationSettings publicKey={vapidPublicKey} />
      </PanelFrame>

      <PanelFrame title="API 访问" subtitle="同一套接口供脚本、Agent 与本界面共同使用">
        <p className="meta">
          鉴权二选一：请求头 <code className="code">Authorization: Bearer 「API Token」</code>，或先在本页登录后由浏览器自动携带的会话
          Cookie。推送订阅接口只接受会话 Cookie，避免 Token 替他人注册设备。
        </p>
        <ul className="list">
          {API_ENDPOINTS.map((endpoint) => (
            <li key={endpoint.path} className="list-item">
              <div className="list-item-head">
                <code className="code">
                  {endpoint.method} {endpoint.path}
                </code>
              </div>
              <p className="meta">{endpoint.note}</p>
            </li>
          ))}
        </ul>
        <p className="meta">
          示例：<code className="code">curl -H "Authorization: Bearer $HIVE_API_TOKEN" "https://本站域名/api/quote?symbols=MU"</code>
        </p>
      </PanelFrame>

      <PanelFrame title="显示" subtitle="界面偏好">
        <p className="meta">
          配色跟随系统深浅色设置自动切换；桌面（≥1024px）为侧边栏布局，手机与平板为顶部栏加底部导航。行情颜色为红涨绿跌。
        </p>
      </PanelFrame>
    </>
  );
}
