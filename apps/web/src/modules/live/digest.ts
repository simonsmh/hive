import type { SourceHealthRow } from "../health/mapper";
import type { QuoteRow } from "../quotes/mapper";

/**
 * Cheap change fingerprints for the SSE stream: the server recomputes them on each tick
 * and only emits an event when the fingerprint moves, so idle connections stay silent
 * apart from heartbeats. They are deliberately content-based (not timestamps of the
 * check itself), so a re-read of unchanged rows never looks like an update. The one
 * exception is health staleness: a collector that stops running leaves its row
 * unchanged while last_success_at ages past max_staleness_minutes, so the *stale
 * flag* (not the age) is part of the fingerprint and the stream fires exactly when a
 * source crosses the threshold.
 */
export function digestQuotes(rows: readonly QuoteRow[]): string {
  return rows.map((row) => `${row.symbol}:${row.price}:${row.ts}`).join("|");
}

export function digestNewest(ids: readonly string[], total: number): string {
  return `${total}:${ids.join(",")}`;
}

export function digestHealth(rows: readonly SourceHealthRow[], nowMs: number): string {
  return rows
    .map((row) => {
      const ageMs = row.last_success_at === null ? null : nowMs - Date.parse(row.last_success_at);
      const stale = ageMs === null || !Number.isFinite(ageMs) || ageMs / 60000 > row.max_staleness_minutes;
      return `${row.source}:${row.enabled ? 1 : 0}:${row.last_success_at ?? ""}:${row.consecutive_failures}:${stale ? 1 : 0}`;
    })
    .join("|");
}
