import type { DeliveryOutcome, DispatchStore, DueDelivery } from "./handler.ts";

const MAX_ERROR_LENGTH = 500;
const MAX_BODY_IN_ERROR = 300;

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface ClaimRow {
  delivery_id: number | string;
  agent_name: string;
  url: string;
  secret: string | null;
  auth_token: string | null;
  event_type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  priority: string;
  event_ts: string | null;
  created_at: string;
  stale_after_seconds: number | string;
}

/**
 * PostgREST RPC store. hive_webhook_claim returns the decrypted signing secret and bearer token, so rows
 * are only ever handled in memory here and never logged.
 */
export function createRestDispatchStore(options: RestStoreOptions): DispatchStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: options.serviceKey,
        authorization: `Bearer ${options.serviceKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST ${name} returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    async claim(limit: number, leaseSeconds: number): Promise<DueDelivery[]> {
      const rows = ((await rpc("hive_webhook_claim", { p_limit: limit, p_lease_seconds: leaseSeconds })) ?? []) as ClaimRow[];
      return rows.map((row) => ({
        deliveryId: Number(row.delivery_id),
        agentName: row.agent_name,
        url: row.url,
        secret: row.secret,
        authToken: row.auth_token ?? null,
        eventType: row.event_type,
        payload: row.payload,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        priority: row.priority === "bulk" ? "bulk" : "critical",
        eventTs: row.event_ts ?? null,
        createdAt: row.created_at,
        staleAfterSeconds: Number(row.stale_after_seconds),
      }));
    },

    async release(deliveryIds: number[]): Promise<void> {
      if (deliveryIds.length === 0) return;
      await rpc("hive_webhook_release", { p_delivery_ids: deliveryIds });
    },

    async mark(deliveryId: number, outcome: DeliveryOutcome): Promise<string> {
      const status = await rpc("hive_webhook_mark", {
        p_delivery_id: deliveryId,
        p_ok: outcome.ok,
        p_response_status: outcome.responseStatus,
        p_error: outcome.error === null ? null : outcome.error.slice(0, MAX_ERROR_LENGTH),
        p_backoff_seconds: outcome.backoffSeconds,
      });
      return typeof status === "string" ? status : "unknown";
    },
  };
}
