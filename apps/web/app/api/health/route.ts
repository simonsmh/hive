import { authorize, handle, jsonResponse } from "../../../lib/api";
import { getDb, assertNoError } from "../../../lib/supabase";
import { buildHealthReport, type SourceHealthRow } from "@/src/modules/health/mapper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const { data, error } = await getDb()
      .from("source_health")
      .select("source, enabled, last_success_at, consecutive_failures, max_staleness_minutes, last_error")
      .order("source");
    assertNoError(error);

    const { report, degraded } = buildHealthReport((data ?? []) as SourceHealthRow[], Date.now());
    return jsonResponse(report, degraded ? 503 : 200);
  });
}
