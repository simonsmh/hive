import { createHash, timingSafeEqual } from "node:crypto";

export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time bearer token check. Both sides are hashed first so the
 * comparison length does not leak the expected token's length. An unset
 * expected token always fails closed.
 */
export function isAuthorized(header: string | null | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const presented = parseBearerToken(header);
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expectedToken));
}
