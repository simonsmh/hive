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
  // 400 from a push service is endpoint-specific (malformed request): after this
  // many consecutive failures the endpoint is dead and the subscription is
  // retired instead of burning the per-run send budget forever. 401/403 are
  // deliberately NOT in this set: they can be credential-level (bad VAPID keys,
  // a push-service auth incident), in which case retiring every affected
  // subscription would wipe them all and force manual re-subscription. They
  // also never feed the failure counter below, so auth rejections alone can
  // never push a subscription over the retirement threshold.
  const PERMANENT_FAILURE_LIMIT = 5;
  const isPermanentRejection = (status: number) => status === 400;
  const isAuthRejection = (status: number) => status === 401 || status === 403;
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
    let retired = 0;
    let failed = 0;
    let attempts = 0;
    let authFailures = 0;

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
            // Bookkeeping must never undo a confirmed delivery: a markSuccess
            // failure is logged here instead of falling into the catch block,
            // which would release the claim and resend an already-delivered push.
            try {
              await deps.store.markSuccess(subscription.id);
            } catch (error) {
              log(`push markSuccess failed for ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            failed++;
            const authRejected = isAuthRejection(result.status);
            if (authRejected) {
              // Auth-level rejection: possibly the VAPID credentials or the
              // push service itself. Never retire on these and never let them
              // feed the permanent-failure counter (a mix of 401/403s and a
              // later 400 must not retire either); a run-level check below
              // flags a likely credential incident instead.
              authFailures++;
            } else if (
              isPermanentRejection(result.status) &&
              (subscription.failure_count ?? 0) + 1 >= PERMANENT_FAILURE_LIMIT
            ) {
              // Dead endpoint (persistent 400): retrying it for every
              // candidate every minute would starve the per-run send budget, so
              // retire the subscription. Its claims cascade-delete with it.
              retired++;
              await deps.store.deleteSubscription(subscription.id);
              break;
            }
            await deps.store.releaseDelivery(subscription.id, candidate.eventKey);
            if (!authRejected) {
              try {
                await deps.store.markFailure(subscription);
              } catch (error) {
                log(`push markFailure failed for ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        } catch (error) {
          failed++;
          log(`push send failed for ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`);
          // Defensive cleanup: a transient REST/database error here must not
          // escape and abort the whole cron run for the remaining candidates.
          try {
            await deps.store.releaseDelivery(subscription.id, candidate.eventKey);
          } catch (cleanupError) {
            log(`push releaseDelivery failed for ${subscription.id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
          try {
            await deps.store.markFailure(subscription);
          } catch (cleanupError) {
            log(`push markFailure failed for ${subscription.id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
      }
    }

    // A majority of 401/403 across this run's deliveries points at the VAPID
    // credentials or the push service rather than any single endpoint; surface
    // it instead of (previously) retiring every affected subscription.
    const authIncident = attempts > 0 && authFailures * 2 >= attempts;
    if (authIncident) {
      log(`push auth incident: ${authFailures}/${attempts} deliveries rejected with 401/403; check VAPID keys`);
    }

    return Response.json({
      ok: true,
      subscriptions: subscriptions.length,
      candidates: candidates.length,
      sent,
      skipped,
      gone,
      retired,
      failed,
      authFailures,
      authIncident,
    });
  };
}
