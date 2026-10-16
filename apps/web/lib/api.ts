import { isAuthorized, SubscriptionInputError } from "@hive/core";
import { readCookieValue, SESSION_COOKIE, verifySessionToken } from "../src/modules/auth/session";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

export function errorResponse(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ error: message }, status, extraHeaders);
}

/**
 * Returns a 401 response unless the request is authenticated, either by the configured
 * bearer token (agents and scripts) or by a valid dashboard session cookie (the browser UI;
 * the cookie is HttpOnly and SameSite=Lax, so cross-site requests cannot ride it).
 * The bearer check runs first so API clients never depend on cookie state.
 */
/**
 * Whether a browser request genuinely came from the dashboard itself. Cookie auth is
 * ambient: SameSite=Lax only blocks cross-*site* requests, so an attacker-controlled
 * sibling origin (same site, e.g. another deployment under the same registrable
 * domain) could otherwise ride the session cookie with a CORS-safelisted
 * `text/plain` POST and hit a state-changing route. Bearer tokens are never ambient,
 * so they are exempt; cookie-authenticated unsafe methods must prove same-origin.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  // Forbidden headers cannot be spoofed by a hostile page, so Sec-Fetch-Site is a
  // reliable fallback when the client omits Origin.
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  return false;
}

export async function authorize(request: Request): Promise<Response | null> {
  const expected = process.env.HIVE_API_TOKEN;
  if (!expected) {
    throw new ConfigError("HIVE_API_TOKEN is not configured");
  }
  if (isAuthorized(request.headers.get("authorization"), expected)) return null;
  const session = readCookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  if (!(await verifySessionToken(session, process.env.HIVE_SESSION_SECRET))) {
    return errorResponse(401, "unauthorized", { "www-authenticate": 'Bearer realm="hive"' });
  }
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !isSameOriginRequest(request)) {
    return errorResponse(403, "cross-origin request forbidden");
  }
  return null;
}

/**
 * Session-cookie-only variant for browser-owned resources (push subscriptions): a
 * bearer token must not be able to register or remove someone else's browser
 * endpoint, so the token path is deliberately not accepted here.
 */
export async function authorizeSession(request: Request): Promise<Response | null> {
  const session = readCookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  if (!(await verifySessionToken(session, process.env.HIVE_SESSION_SECRET))) {
    return errorResponse(401, "unauthorized");
  }
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !isSameOriginRequest(request)) {
    return errorResponse(403, "cross-origin request forbidden");
  }
  return null;
}

/** Wraps a route body so auth/param/config failures map to the right status without leaking internals. */
export async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ParamError) return errorResponse(400, error.message);
    if (error instanceof SubscriptionInputError) return jsonResponse({ error: "invalid subscription", problems: error.problems }, 400);
    if (error instanceof NotFoundError) return errorResponse(404, error.message);
    if (error instanceof ConflictError) return errorResponse(409, error.message);
    if (error instanceof ConfigError) {
      console.error(`[api] ${error.message}`);
      return errorResponse(500, "server misconfigured");
    }
    console.error("[api] unhandled error", error);
    return errorResponse(500, "internal error");
  }
}

/** Parses a JSON request body. Malformed JSON is a client error (400), not a server error. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  try {
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ParamError("body must be valid JSON");
  }
}
