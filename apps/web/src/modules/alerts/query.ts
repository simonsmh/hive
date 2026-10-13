import "server-only";
import { assertNoError, getDb } from "@/lib/supabase";
import type { AlertRow } from "./mapper";

export const ALERT_LIMIT = 50;

export async function loadRecentAlerts(): Promise<AlertRow[]> {
  const { data, error } = await getDb()
    .from("alerts")
    .select("id, kind, symbol, payload, triggered_at")
    .order("triggered_at", { ascending: false })
    .limit(ALERT_LIMIT);
  assertNoError(error);
  return (data ?? []) as AlertRow[];
}
