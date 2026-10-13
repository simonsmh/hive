export interface AlertRow {
  id: number | string;
  kind: string;
  symbol: string | null;
  severity: string;
  payload: unknown;
  triggered_at: string;
  resolved_at: string | null;
}

export interface AlertDetail {
  label: string;
  value: string;
}

export interface AlertView {
  id: string;
  kind: string;
  kindLabel: string;
  symbol: string | null;
  severity: string;
  severityLabel: string;
  triggeredAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  summary: string;
  details: AlertDetail[];
}

export const ALERT_KIND_LABELS: Record<string, string> = {
  source_stale: "数据源过期",
  source_recovered: "数据源恢复",
  price_cross: "价格穿越",
  candle_close_break: "K 线收盘突破",
  volume_spike: "放量",
  long_wick: "长影线",
  pullback: "回调",
};

export const SEVERITY_LABELS: Record<string, string> = {
  info: "信息",
  warning: "警告",
  critical: "严重",
};

const DETAIL_LABELS: Record<string, string> = {
  source: "数据源",
  last_success_at: "最后成功",
  consecutive_failures: "连续失败",
  last_error: "最后错误",
  threshold_minutes: "阈值(分钟)",
  price: "价格",
  threshold: "阈值",
  close: "收盘价",
  volume: "成交量",
};

const MAX_DETAILS = 6;
const MAX_VALUE_LENGTH = 120;

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

export function toAlertView(row: AlertRow): AlertView {
  const payload = asRecord(row.payload);
  const kindLabel = ALERT_KIND_LABELS[row.kind] ?? row.kind;
  const sourceName = stringify(payload.source) ?? "未知";
  const summary =
    row.kind === "source_stale"
      ? `数据源 ${sourceName} 超过允许的更新间隔`
      : row.kind === "source_recovered"
        ? `数据源 ${sourceName} 已恢复更新`
        : `${kindLabel}${row.symbol ? ` · ${row.symbol}` : ""}`;

  const details: AlertDetail[] = [];
  for (const [key, raw] of Object.entries(payload)) {
    if (details.length >= MAX_DETAILS) break;
    const value = stringify(raw);
    if (value === null) continue;
    details.push({ label: DETAIL_LABELS[key] ?? key, value });
  }

  return {
    id: String(row.id),
    kind: row.kind,
    kindLabel,
    symbol: row.symbol,
    severity: row.severity,
    severityLabel: SEVERITY_LABELS[row.severity] ?? row.severity,
    triggeredAt: row.triggered_at,
    resolved: row.resolved_at !== null,
    resolvedAt: row.resolved_at,
    summary,
    details,
  };
}
