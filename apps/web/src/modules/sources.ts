const SOURCE_LABELS: Record<string, string> = {
  okx: "OKX 行情",
  jin10: "Jin10 快讯",
  "okx-news": "OKX 快讯",
  blockbeats: "BlockBeats 快讯",
  yahoo: "Yahoo 行情",
  ths: "同花顺行情",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.toUpperCase();
}
