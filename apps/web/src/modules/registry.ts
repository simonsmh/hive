// Single source of truth for dashboard panels. The nav, PWA shortcuts and tests read from here.
// To add a panel: append an entry, then create app/(dashboard)/<id>/page.tsx (see README).

export const PANEL_ICONS = ["pulse", "chart", "news", "bell", "gear", "list", "target"] as const;
export type PanelIcon = (typeof PANEL_ICONS)[number];

export interface PanelRegistration {
  id: string;
  title: string;
  icon: PanelIcon;
  href: string;
  order: number;
}

export const PANELS: readonly PanelRegistration[] = [
  { id: "health", title: "数据源健康", icon: "pulse", href: "/health", order: 10 },
  { id: "quotes", title: "行情", icon: "chart", href: "/quotes", order: 20 },
  { id: "news", title: "新闻", icon: "news", href: "/news", order: 30 },
  { id: "alerts", title: "告警", icon: "bell", href: "/alerts", order: 40 },
  { id: "symbols", title: "标的管理", icon: "list", href: "/symbols", order: 45 },
  { id: "orders", title: "条件单", icon: "target", href: "/orders", order: 47 },
  { id: "trend", title: "趋势策略", icon: "chart", href: "/trend", order: 48 },
  { id: "settings", title: "设置", icon: "gear", href: "/settings", order: 50 },
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

export function getDefaultHref(panels: readonly PanelRegistration[] = PANELS): string {
  return getNavItems(panels)[0]?.href ?? "/login";
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
    if (!(PANEL_ICONS as readonly string[]).includes(panel.icon)) errors.push(`${label}: unknown icon "${panel.icon}"`);
    if (!Number.isInteger(panel.order)) errors.push(`${label}: order must be an integer`);
    if (orders.has(panel.order)) errors.push(`${label}: duplicate order ${panel.order}`);
    orders.add(panel.order);
  }
  return errors;
}
