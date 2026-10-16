import { isAuthorized } from "./core/auth.ts";
import { sendWebPush, type PushSubscriptionKeys, type VapidKeys } from "./core/webpush.ts";

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  filters: unknown;
  failure_count: number;
}

export interface NewsEventRow {
  id: string;
  /** The schema permits nulls; buildCandidates falls back like the news panel does. */
  title: string | null;
  first_published_at: string;
}

export interface AlertRow {
  id: string;
  kind: string;
  symbol: string | null;
  severity: string;
  payload: unknown;
  triggered_at: string;
}

export interface PushStore {
  listSubscriptions(): Promise<PushSubscriptionRow[]>;
  recentNewsEvents(sinceIso: string, limit: number): Promise<NewsEventRow[]>;
  recentAlerts(sinceIso: string, limit: number): Promise<AlertRow[]>;
  /** Claims (subscription, event) for delivery; false means it was already claimed or sent. */
  claimDelivery(subscriptionId: string, eventKey: string): Promise<boolean>;
  /** Releases a claim after a transient send failure so the next run can retry. */
  releaseDelivery(subscriptionId: string, eventKey: string): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
  markSuccess(id: string): Promise<void>;
  markFailure(subscription: PushSubscriptionRow): Promise<void>;
}

/** Injectable Web Push sender, defaulting to the real core implementation. */
export type SendPushFunction = typeof sendWebPush;

export interface PushNotifyDeps {
  cronSecret: string | undefined;
  vapid: VapidKeys | undefined;
  store: PushStore;
  now?: () => number;
  /**
   * Event lookback window. 30 minutes gives the 200-send-per-run cap a 30x
   * backlog buffer before an unsent event ages out of the window; a persisted
   * cursor would be needed only far beyond this deployment's scale.
   */
  lookbackMinutes?: number;
  maxSendsPerRun?: number;
  sendPush?: SendPushFunction;
  log?: (message: string) => void;
}

export interface PushFilters {
  news: boolean;
  alerts: boolean;
}

/** Missing or malformed filter fields default to on; only an explicit false opts out. */
export function parsePushFilters(raw: unknown): PushFilters {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { news: record.news !== false, alerts: record.alerts !== false };
}

export interface PushCandidate {
  eventKey: string;
  kind: "news" | "alerts";
  title: string;
  body: string;
  url: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function alertBody(alert: AlertRow): string {
  const payload = typeof alert.payload === "object" && alert.payload !== null ? (alert.payload as Record<string, unknown>) : {};
  const message = typeof payload.message === "string" ? payload.message : typeof payload.summary === "string" ? payload.summary : null;
  if (message) return truncate(message, 180);
  return truncate(`${alert.kind}${alert.symbol ? ` · ${alert.symbol}` : ""}`, 180);
}

/** News events all qualify; alerts qualify when critical or about a stale source. */
export function buildCandidates(events: readonly NewsEventRow[], alerts: readonly AlertRow[]): PushCandidate[] {
  const candidates: PushCandidate[] = [];
  for (const event of events) {
    candidates.push({
      eventKey: `news:${event.id}`,
      kind: "news",
      title: "Hive 新闻",
      body: truncate(event.title?.trim() || "未命名事件", 180),
      url: "/news",
    });
  }
  for (const alert of alerts) {
    if (alert.severity !== "critical" && alert.kind !== "source_stale") continue;
    candidates.push({
      eventKey: `alert:${alert.id}`,
      kind: "alerts",
      title: "Hive 告警",
      body: alertBody(alert),
      url: "/alerts",
    });
  }
  return candidates;
}

export function createPushNotifyHandler(deps: PushNotifyDeps) {
  const now = deps.now ?? Date.now;
  const lookbackMinutes = deps.lookbackMinutes ?? 30;
  const maxSends = deps.maxSendsPerRun ?? 200;
  const sendPush = deps.sendPush ?? sendWebPush;
  const log = deps.log ?? (() => undefined);

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" && request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    if (!deps.cronSecret) {
      return Response.json({ error: "EDGE_CRON_SECRET is not configured" }, { status: 500 });
    }
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const vapid = deps.vapid;
    if (!vapid?.publicKey || !vapid?.privateKey || !vapid?.subject) {
      return Response.json({ error: "VAPID keys are not configured" }, { status: 500 });
    }

    const sinceIso = new Date(now() - lookbackMinutes * 60_000).toISOString();
    const [subscriptions, events, alerts] = await Promise.all([
      deps.store.listSubscriptions(),
      // Safety caps, not per-run targets: the store fetches the whole window and
      // the per-run send cap plus the claim ledger spread delivery across runs.
      deps.store.recentNewsEvents(sinceIso, 500),
      deps.store.recentAlerts(sinceIso, 500),
    ]);
    const candidates = buildCandidates(events, alerts);

    let sent = 0;
    let skipped = 0;
    let gone = 0;
    let failed = 0;
    let attempts = 0;

    for (const subscription of subscriptions) {
      const filters = parsePushFilters(subscription.filters);
      const target: PushSubscriptionKeys = {
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      };
      for (const candidate of candidates) {
        if (attempts >= maxSends) break;
        if (candidate.kind === "news" && !filters.news) continue;
        if (candidate.kind === "alerts" && !filters.alerts) continue;
        if (!(await deps.store.claimDelivery(subscription.id, candidate.eventKey))) {
          skipped++;
          continue;
        }
        attempts++;
        try {
          const result = await sendPush(
            target,
            JSON.stringify({ title: candidate.title, body: candidate.body, url: candidate.url, tag: candidate.eventKey }),
            vapid,
            { ttlSeconds: 3600, urgency: candidate.kind === "alerts" ? "high" : "normal" },
          );
          if (result.gone) {
            gone++;
            await deps.store.deleteSubscription(subscription.id);
            break;
          }
          if (result.status >= 200 && result.status < 300) {
            sent++;
            await deps.store.markSuccess(subscription.id);
          } else {
            failed++;
            await deps.store.releaseDelivery(subscription.id, candidate.eventKey);
            await deps.store.markFailure(subscription);
          }
        } catch (error) {
          failed++;
          log(`push send failed for ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`);
          await deps.store.releaseDelivery(subscription.id, candidate.eventKey);
          await deps.store.markFailure(subscription);
        }
      }
    }

    return Response.json({
      ok: true,
      subscriptions: subscriptions.length,
      candidates: candidates.length,
      sent,
      skipped,
      gone,
      failed,
    });
  };
}
