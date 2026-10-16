import "server-only";
import { assertNoError, getDb } from "@/lib/supabase";
import { digestNewest } from "../live/digest";
import type { AlertRow } from "./mapper";

export const ALERT_LIMIT = 50;

const ALERT_COLUMNS = "id, kind, symbol, severity, payload, triggered_at, resolved_at";

export interface AlertFilters {
  kind: string | null;
  symbol: string | null;
  severity: string | null;
  /** true: only open alerts. false: only resolved alerts. null: both. */
  unresolved: boolean | null;
  limit: number;
}

export async function listAlerts(filters: AlertFilters): Promise<AlertRow[]> {
  let query = getDb()
    .from("alerts")
    .select(ALERT_COLUMNS)
    .order("triggered_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(filters.limit);
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.symbol) query = query.eq("symbol", filters.symbol);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (filters.unresolved === true) query = query.is("resolved_at", null);
  if (filters.unresolved === false) query = query.not("resolved_at", "is", null);
  const { data, error } = await query;
  assertNoError(error);
  return (data ?? []) as AlertRow[];
}

export async function loadRecentAlerts(): Promise<AlertRow[]> {
  return listAlerts({ kind: null, symbol: null, severity: null, unresolved: null, limit: ALERT_LIMIT });
}

/**
 * Change key for the alerts feed, shared by the SSE stream and the alerts page's
 * LiveRefresh baseline. Covers every rendered alert's id and resolution timestamp,
 * so resolving any alert — not just the newest — triggers a refresh.
 */
export function digestAlertList(alerts: readonly { id: number | string; resolvedAt: string | null }[]): string {
  return digestNewest(
    alerts.map((alert) => `${alert.id}:${alert.resolvedAt ?? ""}`),
    alerts.length,
  );
}
