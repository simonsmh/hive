const SOURCE_LABELS: Record<string, string> = {
  okx: "OKX 行情",
  jin10: "Jin10 快讯",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.toUpperCase();
}
