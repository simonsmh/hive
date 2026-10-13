import "server-only";
import { assertNoError, getDb } from "@/lib/supabase";
import type { NewsEventRow, NewsItemRow } from "./mapper";

export const NEWS_EVENT_LIMIT = 20;
const NEWS_ITEM_LIMIT = 500;

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
