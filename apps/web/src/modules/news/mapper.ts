export interface NewsEventRow {
  id: string;
  title: string | null;
  first_published_at: string;
}

export interface NewsItemRow {
  id: number | string;
  event_id: string | null;
  source: string;
  title: string | null;
  url: string;
  published_at: string | null;
  credibility: number | string | null;
}

export interface NewsItemView {
  id: string;
  source: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  credibility: number | null;
}

export interface NewsEventView {
  id: string;
  title: string;
  publishedAt: string;
  items: NewsItemView[];
}

/** Only http(s) links are rendered as anchors; anything else (javascript:, data:, relative) becomes plain text. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function publishedMs(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Keeps event order from the query, attaches each item to its event, and drops items whose event is not in the list. */
export function groupNewsByEvent(events: readonly NewsEventRow[], items: readonly NewsItemRow[]): NewsEventView[] {
  const itemsByEvent = new Map<string, NewsItemView[]>();
  const sorted = [...items].sort((a, b) => publishedMs(b.published_at) - publishedMs(a.published_at));
  for (const item of sorted) {
    if (!item.event_id) continue;
    const view: NewsItemView = {
      id: String(item.id),
      source: item.source,
      title: item.title?.trim() || item.url,
      url: safeHttpUrl(item.url),
      publishedAt: item.published_at,
      credibility: item.credibility === null ? null : Number(item.credibility),
    };
    const bucket = itemsByEvent.get(item.event_id);
    if (bucket) bucket.push(view);
    else itemsByEvent.set(item.event_id, [view]);
  }

  return events.map((event) => {
    const eventItems = itemsByEvent.get(event.id) ?? [];
    return {
      id: event.id,
      title: event.title?.trim() || eventItems[0]?.title || "未命名事件",
      publishedAt: event.first_published_at,
      items: eventItems,
    };
  });
}
