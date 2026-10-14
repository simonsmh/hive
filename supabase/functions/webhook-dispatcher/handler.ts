import { isAuthorized } from "./core/auth.ts";
import {
  computeBackoffSeconds,
  DELIVERY_HEADER,
  deliveryFlags,
  type DeliveryPriority,
  EVENT_HEADER,
  MAX_BACKOFF_SECONDS,
  SIGNATURE_HEADER,
  signWebhookBody,
  TIMESTAMP_HEADER,
  withDeliveryFlags,
} from "./core/webhook.ts";

export interface DueDelivery {
  deliveryId: number;
  agentName: string;
  url: string;
  /** Null when the subscription's Vault secret is missing; such deliveries are never sent unsigned. */
  secret: string | null;
  /** Optional bearer token for receivers that authenticate with Authorization: Bearer. Never logged or recorded. */
  authToken: string | null;
  eventType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  priority: DeliveryPriority;
  /** ISO time of the underlying event. Null only when the database could not derive one. */
  eventTs: string | null;
  /** ISO time the delivery row was inserted. Used to tell a live send from a backlog replay. */
  createdAt: string;
  staleAfterSeconds: number;
}

export interface DeliveryOutcome {
  ok: boolean;
  responseStatus: number | null;
  error: string | null;
  backoffSeconds: number;
}

export interface DispatchStore {
  claim(limit: number, leaseSeconds: number): Promise<DueDelivery[]>;
  mark(deliveryId: number, outcome: DeliveryOutcome): Promise<string>;
  /** Returns claimed deliveries to pending and refunds the attempt that claiming counted. */
  release(deliveryIds: number[]): Promise<void>;
}

export interface DispatcherDeps {
  cronSecret: string | undefined;
  store: DispatchStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  batchSize?: number;
  concurrency?: number;
  budgetMs?: number;
  leaseSeconds?: number;
  requestTimeoutMs?: number;
}

export const BATCH_SIZE = 20;
export const CONCURRENCY = 4;
/** Deliveries claimed after this budget are left for the next run, once their lease expires. */
export const BUDGET_MS = 90_000;
export const LEASE_SECONDS = 120;
export const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ERROR_LENGTH = 300;

interface DispatchSummary {
  status: "idle" | "ok" | "partial";
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
  /** Released back to pending because the budget ran out before they were sent. */
  skipped: number;
  /** Bulk deliveries released because the budget was tight. Intentional, so they do not make the run partial. */
  deferred: number;
  durationMs: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

export function createWebhookDispatcher(deps: DispatcherDeps): (request: Request) => Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[webhook-dispatcher] ${message}`));
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const concurrency = deps.concurrency ?? CONCURRENCY;
  const budgetMs = deps.budgetMs ?? BUDGET_MS;
  const leaseSeconds = deps.leaseSeconds ?? LEASE_SECONDS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  async function attempt(due: DueDelivery, body: string, timestamp: number): Promise<DeliveryOutcome> {
    if (due.secret === null) {
      return {
        ok: false,
        responseStatus: null,
        error: "subscription has no signing secret; not sent",
        backoffSeconds: MAX_BACKOFF_SECONDS,
      };
    }
    try {
      const response = await fetchImpl(due.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": "hive-webhook/1",
          [SIGNATURE_HEADER]: signWebhookBody(due.secret, timestamp, body),
          [TIMESTAMP_HEADER]: String(timestamp),
          [EVENT_HEADER]: due.eventType,
          [DELIVERY_HEADER]: String(due.deliveryId),
          ...(due.authToken ? { authorization: `Bearer ${due.authToken}` } : {}),
        },
        body,
      });
      await response.body?.cancel();
      const ok = response.status >= 200 && response.status < 300;
      const redirected = response.status >= 300 && response.status < 400;
      return {
        ok,
        responseStatus: response.status,
        error: ok ? null : `HTTP ${response.status}${redirected ? " (redirects are not followed)" : ""}`,
        backoffSeconds: ok ? 0 : computeBackoffSeconds(due.attempts),
      };
    } catch (error) {
      return {
        ok: false,
        responseStatus: null,
        error: `request failed: ${describeError(error)}`,
        backoffSeconds: computeBackoffSeconds(due.attempts),
      };
    }
  }

  /** Signs and posts one delivery. Never throws; the outcome is always recorded through the store. */
  async function deliver(due: DueDelivery): Promise<string> {
    const nowMs = now();
    const timestamp = Math.floor(nowMs / 1000);
    const flags = deliveryFlags(
      { priority: due.priority, eventTs: due.eventTs, createdAt: due.createdAt, staleAfterSeconds: due.staleAfterSeconds },
      nowMs,
    );
    const body = JSON.stringify({
      delivery_id: due.deliveryId,
      event: due.eventType,
      created_at: new Date(timestamp * 1000).toISOString(),
      data: withDeliveryFlags(due.payload, flags),
    });
    const outcome = await attempt(due, body, timestamp);

    try {
      const status = await deps.store.mark(due.deliveryId, outcome);
      log(`delivery=${due.deliveryId} agent=${due.agentName} priority=${due.priority} stale=${flags.stale} replay=${flags.replay} attempt=${due.attempts} result=${status}${outcome.error ? ` error="${outcome.error}"` : ""}`);
      return status;
    } catch (error) {
      log(`delivery=${due.deliveryId} could not record outcome: ${describeError(error)}`);
      return "mark_failed";
    }
  }

  async function release(items: DueDelivery[]): Promise<void> {
    if (items.length === 0) return;
    try {
      await deps.store.release(items.map((item) => item.deliveryId));
    } catch (error) {
      log(`release failed for ${items.length} deliveries: ${describeError(error)}`);
    }
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const started = now();
    const summary: DispatchSummary = {
      status: "idle",
      claimed: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
      deferred: 0,
      durationMs: 0,
    };
    const worstCaseBatchMs = Math.ceil(batchSize / concurrency) * requestTimeoutMs;
    // Past this point a bulk delivery waits for a later run, so the rest of the budget stays free for critical ones.
    const bulkCutoffMs = budgetMs - worstCaseBatchMs;

    for (;;) {
      let due: DueDelivery[];
      try {
        due = await deps.store.claim(batchSize, leaseSeconds);
      } catch (error) {
        log(`claim failed: ${describeError(error)}`);
        if (summary.claimed === 0) return json(500, { status: "error", error: "could not claim deliveries" });
        break;
      }
      summary.claimed += due.length;

      // The claim returns critical rows first, so a bulk row is only reached after every due critical row in the batch.
      for (let i = 0; i < due.length; i += concurrency) {
        const elapsed = now() - started;
        if (elapsed > budgetMs) {
          const rest = due.slice(i);
          summary.skipped += rest.length;
          await release(rest);
          break;
        }
        const chunk = due.slice(i, i + concurrency);
        const tight = elapsed > bulkCutoffMs;
        const sendable = tight ? chunk.filter((item) => item.priority === "critical") : chunk;
        const deferred = tight ? chunk.filter((item) => item.priority !== "critical") : [];
        summary.deferred += deferred.length;
        await release(deferred);

        const statuses = await Promise.all(sendable.map((item) => deliver(item)));
        for (const status of statuses) {
          if (status === "delivered") summary.delivered += 1;
          else if (status === "dead") summary.dead += 1;
          else summary.failed += 1;
        }
      }

      // Claim another full batch only if it can finish inside the budget, so no claimed row is left leased.
      if (due.length < batchSize || now() - started + worstCaseBatchMs > budgetMs) break;
    }

    summary.durationMs = now() - started;
    if (summary.claimed > 0) summary.status = summary.failed + summary.dead + summary.skipped > 0 ? "partial" : "ok";
    return json(200, summary);
  };
}
