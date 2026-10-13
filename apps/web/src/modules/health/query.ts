import "server-only";
import { assertNoError, getDb } from "@/lib/supabase";
import type { SourceHealthRow } from "./mapper";

export async function loadSourceHealth(): Promise<SourceHealthRow[]> {
  const { data, error } = await getDb()
    .from("source_health")
    .select("source, enabled, last_success_at, consecutive_failures, max_staleness_minutes, last_error")
    .order("source");
  assertNoError(error);
  return (data ?? []) as SourceHealthRow[];
}
