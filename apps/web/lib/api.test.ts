import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorize, authorizeSession, handle, ConfigError } from "./api";
import { createSessionToken, SESSION_COOKIE } from "../src/modules/auth/session";

const TOKEN = "test-hive-token-0123456789abcdef";
const SESSION_SECRET = "s".repeat(40);

describe("authorize", () => {
  beforeEach(() => {
    process.env.HIVE_API_TOKEN = TOKEN;
  });

  afterEach(() => {
    delete process.env.HIVE_API_TOKEN;
    delete process.env.HIVE_SESSION_SECRET;
  });

  it("lets a correct bearer token through", async () => {
    const request = new Request("http://localhost/api/quote", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await authorize(request)).toBeNull();
  });

  it("returns 401 with a WWW-Authenticate challenge when the token is missing or wrong", async () => {
    const missing = await authorize(new Request("http://localhost/api/quote"));
    expect(missing?.status).toBe(401);
    expect(missing?.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await authorize(
      new Request("http://localhost/api/quote", { headers: { authorization: "Bearer nope" } }),
    );
    expect(wrong?.status).toBe(401);
  });

  it("does not accept the token without the Bearer scheme", async () => {
    const request = new Request("http://localhost/api/quote", { headers: { authorization: TOKEN } });
    expect((await authorize(request))?.status).toBe(401);
  });

  it("throws a ConfigError when HIVE_API_TOKEN is unset, so the API fails closed", async () => {
    delete process.env.HIVE_API_TOKEN;
    const request = new Request("http://localhost/api/quote", { headers: { authorization: "Bearer x" } });
    await expect(authorize(request)).rejects.toThrow(ConfigError);
  });

  it("lets a valid dashboard session cookie through for the browser UI", async () => {
    process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    const session = await createSessionToken(SESSION_SECRET);
    const request = new Request("http://localhost/api/quote", {
      headers: { cookie: `theme=dark; ${SESSION_COOKIE}=${session}` },
    });
    expect(await authorize(request)).toBeNull();
  });

  it("rejects a forged or expired session cookie", async () => {
    process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    const forged = new Request("http://localhost/api/quote", {
      headers: { cookie: `${SESSION_COOKIE}=v1.9999999999.forged` },
    });
    expect((await authorize(forged))?.status).toBe(401);

    const expired = await createSessionToken(SESSION_SECRET, Date.now() - 8 * 24 * 60 * 60 * 1000, 60);
    const stale = new Request("http://localhost/api/quote", { headers: { cookie: `${SESSION_COOKIE}=${expired}` } });
    expect((await authorize(stale))?.status).toBe(401);
  });

  it("rejects session cookies when no session secret is configured", async () => {
    delete process.env.HIVE_SESSION_SECRET;
    const request = new Request("http://localhost/api/quote", {
      headers: { cookie: `${SESSION_COOKIE}=v1.9999999999.whatever` },
    });
    expect((await authorize(request))?.status).toBe(401);
  });

  describe("CSRF protection for cookie-authenticated writes", () => {
    const cookieRequest = async (session: string, init: RequestInit = {}) =>
      new Request("http://localhost/api/webhooks", {
        method: "POST",
        body: "{}",
        ...init,
        headers: { cookie: `${SESSION_COOKIE}=${session}`, ...(init.headers as Record<string, string> | undefined) },
      });

    it("lets a same-origin cookie POST through", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
      const session = await createSessionToken(SESSION_SECRET);
      const request = await cookieRequest(session, { headers: { origin: "http://localhost" } });
      expect(await authorize(request)).toBeNull();
    });

    it("rejects a cross-origin cookie POST with 403 (sibling-origin CSRF)", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
      const session = await createSessionToken(SESSION_SECRET);
      // SameSite=Lax is site-scoped: a sibling origin under the same registrable
      // domain could ride the session cookie with a CORS-safelisted POST.
      const request = await cookieRequest(session, { headers: { origin: "http://evil.localhost" } });
      expect((await authorize(request))?.status).toBe(403);
    });

    it("rejects a cookie POST with no origin proof at all", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
      const session = await createSessionToken(SESSION_SECRET);
      expect((await authorize(await cookieRequest(session)))?.status).toBe(403);
    });

    it("still lets bearer-authenticated POSTs through without origin headers", async () => {
      const request = new Request("http://localhost/api/webhooks", {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await authorize(request)).toBeNull();
    });

    it("still lets cookie-authenticated GETs through without origin headers", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
      const session = await createSessionToken(SESSION_SECRET);
      const request = new Request("http://localhost/api/webhooks", {
        headers: { cookie: `${SESSION_COOKIE}=${session}` },
      });
      expect(await authorize(request)).toBeNull();
    });
  });
});

describe("authorizeSession", () => {
  const sessionRequest = async (session: string | null, init: RequestInit = {}) =>
    new Request("http://localhost/api/push/subscriptions", {
      method: "POST",
      body: "{}",
      ...init,
      headers: {
        ...(session === null ? {} : { cookie: `${SESSION_COOKIE}=${session}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  it("lets a same-origin session POST through", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    const session = await createSessionToken(SESSION_SECRET);
    const request = await sessionRequest(session, { headers: { origin: "http://localhost" } });
    expect(await authorizeSession(request)).toBeNull();
  });

  it("rejects a cross-origin session POST with 403 (sibling-origin CSRF)", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    const session = await createSessionToken(SESSION_SECRET);
    // SameSite=Lax is site-scoped: a sibling origin under the same registrable
    // domain could ride the session cookie with a CORS-safelisted POST to
    // register or overwrite someone else's push endpoint.
    const request = await sessionRequest(session, { headers: { origin: "http://evil.localhost" } });
    expect((await authorizeSession(request))?.status).toBe(403);
  });

  it("rejects a session POST with no origin proof at all", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    const session = await createSessionToken(SESSION_SECRET);
    expect((await authorizeSession(await sessionRequest(session)))?.status).toBe(403);
  });

  it("still rejects an invalid session with 401 before any origin check", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    const request = await sessionRequest("bogus", { headers: { origin: "http://localhost" } });
    expect((await authorizeSession(request))?.status).toBe(401);
  });

  it("still lets session GETs through without origin headers", async () => {
      process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    const session = await createSessionToken(SESSION_SECRET);
    const request = new Request("http://localhost/api/push/subscriptions", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(await authorizeSession(request)).toBeNull();
  });
});

describe("handle", () => {
  it("maps configuration errors to 500 without leaking the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handle(async () => {
      throw new ConfigError("SUPABASE_URL missing");
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "server misconfigured" });
    spy.mockRestore();
  });

  it("maps unexpected errors to a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handle(async () => {
      throw new Error("db password is hunter2");
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
    spy.mockRestore();
  });
});
