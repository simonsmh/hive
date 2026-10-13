export interface SourceHealthRow {
  source: string;
  enabled: boolean;
  last_success_at: string | null;
  consecutive_failures: number;
  max_staleness_minutes: number;
  last_error: string | null;
}

export interface SourceHealthView extends SourceHealthRow {
  age_minutes: number | null;
  stale: boolean;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checked_at: string;
  sources: SourceHealthView[];
}

/**
 * Shared by GET /api/health and the dashboard panel. A source is stale when it has never
 * succeeded or its last success is older than its threshold. Only enabled, stale sources
 * degrade the overall status.
 */
export function buildHealthReport(rows: readonly SourceHealthRow[], nowMs: number): { report: HealthReport; degraded: boolean } {
  const sources = rows.map((row): SourceHealthView => {
    const ageMinutes = row.last_success_at ? (nowMs - Date.parse(row.last_success_at)) / 60_000 : null;
    const stale = ageMinutes === null || ageMinutes > row.max_staleness_minutes;
    return { ...row, age_minutes: ageMinutes === null ? null : Math.round(ageMinutes * 10) / 10, stale };
  });
  const degraded = sources.some((s) => s.enabled && s.stale);
  return {
    report: { status: degraded ? "degraded" : "ok", checked_at: new Date(nowMs).toISOString(), sources },
    degraded,
  };
}
