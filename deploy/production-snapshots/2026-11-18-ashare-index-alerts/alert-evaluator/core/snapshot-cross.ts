export type SnapshotDirection = "above" | "below";

export interface SnapshotCrossParams {
  kind: "snapshot_cross";
  level: number;
  direction: SnapshotDirection;
  /** When true, the watch must be disabled after the first inserted alert. */
  once: boolean;
  maxQuoteAgeSeconds: number;
}

export interface SnapshotQuote {
  price: number;
  ts: number;
}

export const DEFAULT_SNAPSHOT_MAX_QUOTE_AGE_SECONDS = 480;

export class SnapshotCrossError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCrossError";
  }
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SnapshotCrossError("rule params must be an object");
  }
  return raw as Record<string, unknown>;
}

export function parseSnapshotCrossParams(raw: unknown): SnapshotCrossParams {
  const obj = requireObject(raw);
  const level = obj.level;
  if (typeof level !== "number" || !Number.isFinite(level) || level <= 0) {
    throw new SnapshotCrossError("level must be a finite number greater than 0");
  }
  if (obj.direction !== "above" && obj.direction !== "below") {
    throw new SnapshotCrossError('direction must be "above" or "below"');
  }
  const once = obj.once ?? true;
  if (typeof once !== "boolean") throw new SnapshotCrossError("once must be a boolean");
  const maxQuoteAgeSeconds = obj.maxQuoteAgeSeconds ?? DEFAULT_SNAPSHOT_MAX_QUOTE_AGE_SECONDS;
  if (
    typeof maxQuoteAgeSeconds !== "number" ||
    !Number.isInteger(maxQuoteAgeSeconds) ||
    maxQuoteAgeSeconds < 60 ||
    maxQuoteAgeSeconds > 3600
  ) {
    throw new SnapshotCrossError("maxQuoteAgeSeconds must be an integer between 60 and 3600");
  }
  return { kind: "snapshot_cross", level, direction: obj.direction, once, maxQuoteAgeSeconds };
}

export function isFreshQuote(quoteTs: number, maxQuoteAgeSeconds: number, nowMs: number): boolean {
  if (quoteTs - nowMs > 120_000) return false;
  return nowMs - quoteTs <= maxQuoteAgeSeconds * 1000;
}

/**
 * True when a fresh quote has crossed `level` relative to the previously
 * armed quote. A first observation only arms the watch and must not fire,
 * including when that first quote is already on the far side of the level.
 */
export function evaluateSnapshotCross(
  params: SnapshotCrossParams,
  previous: SnapshotQuote | null,
  last: SnapshotQuote,
): boolean {
  if (previous === null) return false;
  if (!(last.ts > previous.ts)) return false;
  if (params.direction === "above") return previous.price < params.level && last.price >= params.level;
  return previous.price > params.level && last.price <= params.level;
}
