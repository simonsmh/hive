// Dependency-free (Web Crypto only) so the same code runs in Edge middleware and Node server actions.

export const SESSION_COOKIE = "hive_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;

const TOKEN_VERSION = "v1";
const encoder = new TextEncoder();

/** The session secret must be long enough to make HMAC forgery infeasible; shorter values fail closed. */
export function isUsableSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Token format: `v1.<expiresAtUnixSeconds>.<base64url HMAC-SHA256 of "v1.<exp>">`. */
export async function createSessionToken(
  secret: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  if (!isUsableSecret(secret)) throw new Error("session secret is missing or too short");
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!token || !isUsableSecret(secret)) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;
  const [, expiresRaw, signatureRaw] = parts as [string, string, string];
  if (!/^\d+$/.test(expiresRaw)) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= nowMs) return false;
  const signature = fromBase64Url(signatureRaw);
  if (!signature) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, encoder.encode(`${TOKEN_VERSION}.${expiresRaw}`));
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Hashes both sides first so the comparison does not leak the configured password's length. */
export async function checkDashboardPassword(presented: string, expected: string | undefined): Promise<boolean> {
  if (!expected || presented.length === 0) return false;
  const [presentedDigest, expectedDigest] = await Promise.all([sha256(presented), sha256(expected)]);
  return constantTimeEquals(presentedDigest, expectedDigest);
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Only same-origin relative paths are allowed, so the login redirect cannot be used as an open redirect. */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\") || hasControlCharacter(raw)) return "/";
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return "/";
  return raw;
}

const PUBLIC_PATHS = new Set(["/login", "/offline", "/manifest.webmanifest", "/sw.js", "/favicon.ico"]);

/**
 * Pages behind the login gate. /api/* is excluded on purpose: those routes keep their own
 * Bearer-token check, and agents must not be redirected to an HTML login page.
 */
export function isGatedPath(pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/") || pathname.startsWith("/icons/")) return false;
  return !PUBLIC_PATHS.has(pathname);
}

export interface SessionCookie {
  name: string;
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

export function sessionCookieAttributes(maxAgeSeconds: number = SESSION_TTL_SECONDS): SessionCookie {
  return { name: SESSION_COOKIE, httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: maxAgeSeconds };
}
