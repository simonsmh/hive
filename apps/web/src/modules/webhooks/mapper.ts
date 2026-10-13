import { randomBytes } from "node:crypto";

export const DELIVERY_STATUSES = ["pending", "sending", "delivered", "dead"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "待重试",
  sending: "发送中",
  delivered: "已送达",
  dead: "已放弃",
};

/** Row shape of public.webhook_subscriptions as selected by the API. secret_id itself is never exposed. */
export interface SubscriptionRow {
  id: string;
  agent_name: string;
  url: string;
  event_types: string[];
  filters: unknown;
  enabled: boolean;
  secret_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionView {
  id: string;
  agent_name: string;
  url: string;
  event_types: string[];
  filters: Record<string, unknown>;
  enabled: boolean;
  secret_configured: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: number | string;
  event_type: string;
  event_key: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  response_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  webhook_subscriptions: { agent_name: string } | { agent_name: string }[] | null;
}

export interface DeliveryView {
  id: string;
  agent_name: string;
  event_type: string;
  status: DeliveryStatus | "unknown";
  status_label: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  response_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface DeliverySummary {
  window_hours: number;
  counts: Record<DeliveryStatus, number>;
  recent_failures: DeliveryView[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toSubscriptionView(row: SubscriptionRow): SubscriptionView {
  return {
    id: row.id,
    agent_name: row.agent_name,
    url: row.url,
    event_types: row.event_types,
    filters: asRecord(row.filters),
    enabled: row.enabled,
    secret_configured: row.secret_id !== null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function toDeliveryView(row: DeliveryRow): DeliveryView {
  const subscription = Array.isArray(row.webhook_subscriptions) ? row.webhook_subscriptions[0] : row.webhook_subscriptions;
  const status = isDeliveryStatus(row.status) ? row.status : "unknown";
  return {
    id: String(row.id),
    agent_name: subscription?.agent_name ?? "未知订阅",
    event_type: row.event_type,
    status,
    status_label: status === "unknown" ? "未知" : DELIVERY_STATUS_LABELS[status],
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at,
    response_status: row.response_status,
    last_error: row.last_error,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
  };
}

const MAX_RECENT_FAILURES = 5;

/** Counts deliveries by status and keeps the newest failed ones (pending retries or dead letters) for the panel. */
export function summarizeDeliveries(rows: readonly DeliveryRow[], windowHours: number): DeliverySummary {
  const counts: Record<DeliveryStatus, number> = { pending: 0, sending: 0, delivered: 0, dead: 0 };
  const views = rows.map(toDeliveryView);
  for (const view of views) {
    if (view.status !== "unknown") counts[view.status] += 1;
  }
  const recent_failures = views
    .filter((view) => view.status === "dead" || (view.status === "pending" && view.last_error !== null))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_RECENT_FAILURES);
  return { window_hours: windowHours, counts, recent_failures };
}

/** Random 32-byte signing secret, hex-encoded (64 characters, within the 32-256 range the core validator accepts). */
export function generateSigningSecret(): string {
  return randomBytes(32).toString("hex");
}
