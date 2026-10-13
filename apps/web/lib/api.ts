import { isAuthorized, SubscriptionInputError } from "@hive/core";

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

/** Returns a 401 response unless the request carries the configured bearer token. */
export function authorize(request: Request): Response | null {
  const expected = process.env.HIVE_API_TOKEN;
  if (!expected) {
    throw new ConfigError("HIVE_API_TOKEN is not configured");
  }
  if (!isAuthorized(request.headers.get("authorization"), expected)) {
    return errorResponse(401, "unauthorized", { "www-authenticate": 'Bearer realm="hive"' });
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
