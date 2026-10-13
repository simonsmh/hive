const BEIJING_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatBeijingTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : BEIJING_TIME.format(ms);
}

/** Daily candles are UTC bars (`1D` = 00:00 UTC), so their labels are UTC dates. */
export function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatAge(minutes: number | null): string {
  if (minutes === null) return "从未成功";
  if (minutes < 1) return "不到 1 分钟前";
  if (minutes < 60) return `${Math.round(minutes)} 分钟前`;
  if (minutes < 60 * 48) return `${(minutes / 60).toFixed(1)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

export function formatPrice(value: number): string {
  const absolute = Math.abs(value);
  const maximumFractionDigits = absolute >= 100 ? 2 : absolute >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatCredibility(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
