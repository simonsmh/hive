import type { AlertRow, NewsEventRow, PushStore, PushSubscriptionRow } from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * PostgREST-backed store. Delivery claims are single inserts with
 * `resolution=ignore-duplicates` + `return=representation`: an empty result means the
 * (subscription, event) pair was already claimed, which is the dedupe guarantee.
 */
export function createRestPushStore(options: RestStoreOptions): PushStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (prefer) headers["prefer"] = prefer;
    const response = await fetchImpl(`${base}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`push store ${method} ${path} failed (${response.status}): ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return text.trim() === "" ? null : JSON.parse(text);
  }

  return {
    async listSubscriptions(): Promise<PushSubscriptionRow[]> {
      const rows = await request(
        "GET",
        "push_subscriptions?select=id,endpoint,p256dh,auth,filters,failure_count&order=created_at.asc",
      );
      return (rows ?? []) as PushSubscriptionRow[];
    },

    async recentNewsEvents(sinceIso: string, limit: number): Promise<NewsEventRow[]> {
      // Page through the window instead of a single top-N query: a poll batch can
      // ingest more events than one page holds, and a fixed cap would silently drop
      // the older ones from that batch forever.
      const pageSize = 100;
      const maxPages = Math.max(1, Math.ceil(limit / pageSize));
      const events: NewsEventRow[] = [];
      for (let page = 0; page < maxPages; page++) {
        const rows = (await request(
          "GET",
          `news_events?select=id,title,first_published_at&first_published_at=gte.${encodeURIComponent(sinceIso)}&order=first_published_at.desc&limit=${pageSize}&offset=${page * pageSize}`,
        )) as NewsEventRow[] | null;
        if (!rows || rows.length === 0) break;
        events.push(...rows);
        if (rows.length < pageSize) break;
      }
      return events;
    },

    async recentAlerts(sinceIso: string, limit: number): Promise<AlertRow[]> {
      // Apply the eligibility predicate in PostgREST, before the limit: filtering in
      // memory after a top-N query would let 50 newer ordinary alerts permanently
      // hide an older critical or source_stale alert that never gets delivered.
      const rows = await request(
        "GET",
        `alerts?select=id,kind,symbol,severity,payload,triggered_at&triggered_at=gte.${encodeURIComponent(sinceIso)}&or=${encodeURIComponent("(severity.eq.critical,kind.eq.source_stale)")}&order=triggered_at.desc&limit=${limit}`,
      );
      return (rows ?? []) as AlertRow[];
    },

    async claimDelivery(subscriptionId: string, eventKey: string): Promise<boolean> {
      // Lease semantics live in hive_push_claim: a fresh conflicting claim reports
      // "already taken", a claim older than 30 minutes is refreshed and acquired.
      const claimed = await request("POST", "rpc/hive_push_claim", {
        p_subscription_id: subscriptionId,
        p_event_key: eventKey,
      });
      return claimed === true;
    },

    async releaseDelivery(subscriptionId: string, eventKey: string): Promise<void> {
      await request(
        "DELETE",
        `push_deliveries?subscription_id=eq.${encodeURIComponent(subscriptionId)}&event_key=eq.${encodeURIComponent(eventKey)}`,
      );
    },

    async deleteSubscription(id: string): Promise<void> {
      await request("DELETE", `push_subscriptions?id=eq.${encodeURIComponent(id)}`);
    },

    async markSuccess(id: string): Promise<void> {
      await request("PATCH", `push_subscriptions?id=eq.${encodeURIComponent(id)}`, {
        last_success_at: new Date().toISOString(),
        failure_count: 0,
        updated_at: new Date().toISOString(),
      });
    },

    async markFailure(subscription: PushSubscriptionRow): Promise<void> {
      await request("PATCH", `push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, {
        failure_count: (subscription.failure_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      });
    },
  };
}
