import "server-only";
import type { SubscriptionFilters } from "@hive/core";
import { ConflictError, NotFoundError } from "@/lib/api";
import { assertNoError, getDb } from "@/lib/supabase";
import { summarizeDeliveries, toDeliveryView, toSubscriptionView, type DeliveryRow, type DeliverySummary, type DeliveryView, type SubscriptionRow, type SubscriptionView } from "./mapper";

const SUBSCRIPTION_COLUMNS = "id, agent_name, url, event_types, filters, enabled, secret_id, created_at, updated_at";
const DELIVERY_COLUMNS =
  "id, event_type, event_key, status, attempts, max_attempts, next_attempt_at, response_status, last_error, delivered_at, created_at, updated_at, webhook_subscriptions(agent_name)";

export const SUMMARY_WINDOW_HOURS = 24;
const SUMMARY_ROW_LIMIT = 2000;

export interface SubscriptionWrite {
  id: string | null;
  agent_name: string | undefined;
  url: string | undefined;
  secret: string | null;
  event_types: string[] | undefined;
  filters: SubscriptionFilters | undefined;
  enabled: boolean | undefined;
}

export async function listSubscriptionViews(): Promise<SubscriptionView[]> {
  const { data, error } = await getDb().from("webhook_subscriptions").select(SUBSCRIPTION_COLUMNS).order("agent_name");
  assertNoError(error);
  return ((data ?? []) as SubscriptionRow[]).map(toSubscriptionView);
}

export async function findSubscriptionByName(agentName: string): Promise<boolean> {
  const { data, error } = await getDb().from("webhook_subscriptions").select("id").eq("agent_name", agentName).limit(1);
  assertNoError(error);
  return (data ?? []).length > 0;
}

/** Calls the write RPC with every argument spelled out, because PostgREST cannot match a function call that omits arguments. */
export async function writeSubscription(write: SubscriptionWrite): Promise<SubscriptionView> {
  const { data, error } = await getDb().rpc("hive_upsert_webhook_subscription", {
    p_id: write.id,
    p_agent_name: write.agent_name ?? null,
    p_url: write.url ?? null,
    p_secret: write.secret,
    p_event_types: write.event_types ?? null,
    p_filters: write.filters ?? null,
    p_enabled: write.enabled ?? null,
  });
  if (error) {
    if (error.code === "23505") throw new ConflictError("agent_name already exists");
    if (error.code === "P0002") throw new NotFoundError("subscription not found");
    assertNoError(error);
  }
  const id = String(data);
  const { data: row, error: readError } = await getDb().from("webhook_subscriptions").select(SUBSCRIPTION_COLUMNS).eq("id", id).single();
  assertNoError(readError);
  return toSubscriptionView(row as SubscriptionRow);
}

export async function removeSubscription(id: string): Promise<void> {
  const { data, error } = await getDb().rpc("hive_delete_webhook_subscription", { p_id: id });
  assertNoError(error);
  if (data !== true) throw new NotFoundError("subscription not found");
}

export async function listDeliveryViews(options: { status: string | null; agentName: string | null; limit: number }): Promise<DeliveryView[]> {
  let query = getDb().from("webhook_deliveries").select(DELIVERY_COLUMNS).order("created_at", { ascending: false }).limit(options.limit);
  if (options.status) query = query.eq("status", options.status);
  if (options.agentName) {
    const { data: subscription, error: lookupError } = await getDb()
      .from("webhook_subscriptions")
      .select("id")
      .eq("agent_name", options.agentName)
      .maybeSingle();
    assertNoError(lookupError);
    if (!subscription) return [];
    query = query.eq("subscription_id", (subscription as { id: string }).id);
  }
  const { data, error } = await query;
  assertNoError(error);
  return ((data ?? []) as unknown as DeliveryRow[]).map(toDeliveryView);
}

/** Dashboard summary over the last SUMMARY_WINDOW_HOURS. Capped so a flood of deliveries cannot slow the panel down. */
export async function loadDeliverySummary(): Promise<DeliverySummary> {
  const since = new Date(Date.now() - SUMMARY_WINDOW_HOURS * 3_600_000).toISOString();
  const { data, error } = await getDb()
    .from("webhook_deliveries")
    .select(DELIVERY_COLUMNS)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(SUMMARY_ROW_LIMIT);
  assertNoError(error);
  return summarizeDeliveries((data ?? []) as unknown as DeliveryRow[], SUMMARY_WINDOW_HOURS);
}
