import "server-only";
import { assertNoError, getDb } from "@/lib/supabase";
import type { NewsEventRow, NewsItemDetailRow, NewsItemRow } from "./mapper";
import { newsSearchOrFilter } from "./search";

export const NEWS_EVENT_LIMIT = 20;
const NEWS_ITEM_LIMIT = 500;
const NEWS_ITEM_DETAIL_COLUMNS = "id, event_id, source, title, body, url, published_at, credibility";

export interface NewsItemFilters {
  source: string | null;
  q: string | null;
  since: string | null;
  limit: number;
}

/** Two queries instead of an embed: news_events and news_items reference each other, so PostgREST embedding would be ambiguous. */
export async function loadRecentNews(): Promise<{ events: NewsEventRow[]; items: NewsItemRow[] }> {
  const { data: eventData, error: eventError } = await getDb()
    .from("news_events")
    .select("id, title, first_published_at")
    .order("first_published_at", { ascending: false })
    .limit(NEWS_EVENT_LIMIT);
  assertNoError(eventError);

  const events = (eventData ?? []) as NewsEventRow[];
  if (events.length === 0) return { events, items: [] };

  const { data: itemData, error: itemError } = await getDb()
    .from("news_items")
    .select("id, event_id, source, title, url, published_at, credibility")
    .in(
      "event_id",
      events.map((event) => event.id),
    )
    .order("published_at", { ascending: false })
    .limit(NEWS_ITEM_LIMIT);
  assertNoError(itemError);

  return { events, items: (itemData ?? []) as NewsItemRow[] };
}

export async function listNewsItems(filters: NewsItemFilters): Promise<NewsItemDetailRow[]> {
  let query = getDb()
    .from("news_items")
    .select(NEWS_ITEM_DETAIL_COLUMNS)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(filters.limit);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.since) query = query.gte("published_at", filters.since);
  if (filters.q) query = query.or(newsSearchOrFilter(filters.q));
  const { data, error } = await query;
  assertNoError(error);
  return (data ?? []) as NewsItemDetailRow[];
}
