// Single source of truth for dashboard panels. The nav, PWA shortcuts and tests read from here.
// To add a panel: append an entry, then create app/(dashboard)/<id>/page.tsx (see README).

export const HOME_HREF = "/";

export const PANEL_ICONS = ["pulse", "chart", "news", "bell", "gear", "list", "target"] as const;
export type PanelIcon = (typeof PANEL_ICONS)[number];

export interface PanelRegistration {
  id: string;
  title: string;
  icon: PanelIcon;
  href: string;
  order: number;
  /** One-line description for the home catalog. Must describe an existing panel, never a planned feature. */
  summary: string;
}

export const PANELS: readonly PanelRegistration[] = [
  { id: "health", title: "数据源健康", icon: "pulse", href: "/health", order: 10, summary: "查看各数据源最近一次成功采集，以及是否过期" },
  { id: "quotes", title: "行情", icon: "chart", href: "/quotes", order: 20, summary: "查看 OKX 永续合约报价与 K 线" },
  { id: "market", title: "市场", icon: "chart", href: "/market", order: 25, summary: "查看同花顺行业指数涨跌与全市场涨跌分布" },
  { id: "ma-deviation", title: "瞬时趋势", icon: "pulse", href: "/ma-deviation", order: 26, summary: "查看 OKX 永续与 A 股 1 分钟均线偏离的瞬时趋势" },
  { id: "etf-volume", title: "ETF 成交观察", icon: "chart", href: "/etf-volume", order: 27, summary: "宽基 ETF 同刻成交额比、放缩量与 ETF 涨跌" },
  { id: "news", title: "新闻", icon: "news", href: "/news", order: 30, summary: "按首次发布时间浏览最近新闻事件" },
  { id: "alerts", title: "告警", icon: "bell", href: "/alerts", order: 40, summary: "按触发时间浏览最近告警" },
  { id: "symbols", title: "标的管理", icon: "list", href: "/symbols", order: 45, summary: "管理采集标的；添加后采集器在下一分钟内自动跟上" },
  { id: "orders", title: "条件单", icon: "target", href: "/orders", order: 47, summary: "查看已有条件单与评估状态，不在此目录下单" },
  { id: "trend", title: "趋势策略", icon: "chart", href: "/trend", order: 48, summary: "查看趋势策略与评估状态，不在此目录下单" },
  { id: "settings", title: "设置", icon: "gear", href: "/settings", order: 50, summary: "通知推送、API 访问说明与显示偏好" },
];

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function getNavItems(panels: readonly PanelRegistration[] = PANELS): PanelRegistration[] {
  return [...panels].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function requirePanel(id: string, panels: readonly PanelRegistration[] = PANELS): PanelRegistration {
  const panel = panels.find((p) => p.id === id);
  if (!panel) throw new Error(`unknown dashboard panel "${id}"`);
  return panel;
}

/** Logged-in users land on the feature catalog, not the first nav panel. */
export function getDefaultHref(panels: readonly PanelRegistration[] = PANELS): string {
  return panels.length === 0 ? "/login" : HOME_HREF;
}

/** Returns human-readable problems; an empty array means the registry is well-formed. */
export function validateRegistry(panels: readonly PanelRegistration[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const hrefs = new Set<string>();
  const orders = new Set<number>();

  for (const panel of panels) {
    const label = `panel "${panel.id}"`;
    if (!ID_PATTERN.test(panel.id)) errors.push(`${label}: id must be lowercase letters, digits or dashes`);
    if (ids.has(panel.id)) errors.push(`${label}: duplicate id`);
    ids.add(panel.id);
    if (panel.href !== `/${panel.id}`) errors.push(`${label}: href must be "/${panel.id}" to match app/(dashboard)/${panel.id}/page.tsx`);
    if (hrefs.has(panel.href)) errors.push(`${label}: duplicate href ${panel.href}`);
    hrefs.add(panel.href);
    if (panel.title.trim() === "") errors.push(`${label}: title is empty`);
    if (panel.summary.trim() === "") errors.push(`${label}: summary is empty`);
    if (!(PANEL_ICONS as readonly string[]).includes(panel.icon)) errors.push(`${label}: unknown icon "${panel.icon}"`);
    if (!Number.isInteger(panel.order)) errors.push(`${label}: order must be an integer`);
    if (orders.has(panel.order)) errors.push(`${label}: duplicate order ${panel.order}`);
    orders.add(panel.order);
  }
  return errors;
}
