import { isAuthorized } from "./core/auth.ts";
import {
  computeBackoffSeconds,
  DELIVERY_HEADER,
  EVENT_HEADER,
  MAX_BACKOFF_SECONDS,
  SIGNATURE_HEADER,
  signWebhookBody,
  TIMESTAMP_HEADER,
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
  skipped: number;
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
    const timestamp = Math.floor(now() / 1000);
    const body = JSON.stringify({
      delivery_id: due.deliveryId,
      event: due.eventType,
      created_at: new Date(timestamp * 1000).toISOString(),
      data: due.payload,
    });
    const outcome = await attempt(due, body, timestamp);

    try {
      const status = await deps.store.mark(due.deliveryId, outcome);
      log(`delivery=${due.deliveryId} agent=${due.agentName} attempt=${due.attempts} result=${status}${outcome.error ? ` error="${outcome.error}"` : ""}`);
      return status;
    } catch (error) {
      log(`delivery=${due.deliveryId} could not record outcome: ${describeError(error)}`);
      return "mark_failed";
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
      durationMs: 0,
    };
    const worstCaseBatchMs = Math.ceil(batchSize / concurrency) * requestTimeoutMs;

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

      for (let i = 0; i < due.length; i += concurrency) {
        if (now() - started > budgetMs) {
          summary.skipped += due.length - i;
          break;
        }
        const chunk = due.slice(i, i + concurrency);
        const statuses = await Promise.all(chunk.map((item) => deliver(item)));
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
