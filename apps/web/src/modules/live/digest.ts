import type { SourceHealthRow } from "../health/mapper";
import type { QuoteRow } from "../quotes/mapper";

/**
 * Cheap change fingerprints for the SSE stream: the server recomputes them on each tick
 * and only emits an event when the fingerprint moves, so idle connections stay silent
 * apart from heartbeats. They are deliberately content-based (not timestamps of the
 * check itself), so a re-read of unchanged rows never looks like an update.
 */
export function digestQuotes(rows: readonly QuoteRow[]): string {
  return rows.map((row) => `${row.symbol}:${row.price}:${row.ts}`).join("|");
}

export function digestNewest(ids: readonly string[], total: number): string {
  return `${total}:${ids.join(",")}`;
}

export function digestHealth(rows: readonly SourceHealthRow[]): string {
  return rows
    .map((row) => `${row.source}:${row.enabled ? 1 : 0}:${row.last_success_at ?? ""}:${row.consecutive_failures}`)
    .join("|");
}
