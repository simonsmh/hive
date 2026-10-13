import { authorize, handle, jsonResponse } from "../../../lib/api";
import { getDb, assertNoError } from "../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthRow {
  source: string;
  enabled: boolean;
  last_success_at: string | null;
  consecutive_failures: number;
  max_staleness_minutes: number;
  last_error: string | null;
}

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const { data, error } = await getDb()
      .from("source_health")
      .select("source, enabled, last_success_at, consecutive_failures, max_staleness_minutes, last_error")
      .order("source");
    assertNoError(error);

    const now = Date.now();
    const sources = ((data ?? []) as HealthRow[]).map((row) => {
      const ageMinutes = row.last_success_at ? (now - Date.parse(row.last_success_at)) / 60_000 : null;
      const stale = ageMinutes === null || ageMinutes > row.max_staleness_minutes;
      return { ...row, age_minutes: ageMinutes === null ? null : Math.round(ageMinutes * 10) / 10, stale };
    });
    const degraded = sources.some((s) => s.enabled && s.stale);

    return jsonResponse({ status: degraded ? "degraded" : "ok", checked_at: new Date(now).toISOString(), sources }, degraded ? 503 : 200);
  });
}
