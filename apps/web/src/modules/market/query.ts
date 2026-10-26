import "server-only";
import { getDb } from "@/lib/supabase";
import { buildMarketBoard, type MarketBoard, type SnapshotRow } from "./board";

const KINDS = ["ths_industry", "ths_breadth", "ths_limit_up_pool", "ths_limit_down_pool"];

/** Latest stored row per kind; an empty board when the collector has not written yet. */
export async function loadMarketBoard(): Promise<MarketBoard> {
  const db = getDb();
  const { data, error } = await db
    .from("daily_snapshot")
    .select("snapshot_date,kind,payload")
    .in("kind", KINDS)
    .order("snapshot_date", { ascending: false })
    .limit(40);
  if (error) throw new Error(`database query failed: ${error.message}`);
  const rows = ((data ?? []) as SnapshotRow[]).sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));
  const seen = new Set<string>();
  const latest: SnapshotRow[] = [];
  for (const row of rows) {
    if (seen.has(row.kind)) continue;
    seen.add(row.kind);
    latest.push(row);
  }
  return buildMarketBoard(latest);
}
