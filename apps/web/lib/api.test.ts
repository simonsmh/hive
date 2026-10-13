import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorize, handle, ConfigError } from "./api";

const TOKEN = "test-hive-token-0123456789abcdef";

describe("authorize", () => {
  beforeEach(() => {
    process.env.HIVE_API_TOKEN = TOKEN;
  });

  afterEach(() => {
    delete process.env.HIVE_API_TOKEN;
  });

  it("lets a correct bearer token through", () => {
    const request = new Request("http://localhost/api/quote", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(authorize(request)).toBeNull();
  });

  it("returns 401 with a WWW-Authenticate challenge when the token is missing or wrong", () => {
    const missing = authorize(new Request("http://localhost/api/quote"));
    expect(missing?.status).toBe(401);
    expect(missing?.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = authorize(new Request("http://localhost/api/quote", { headers: { authorization: "Bearer nope" } }));
    expect(wrong?.status).toBe(401);
  });

  it("does not accept the token without the Bearer scheme", () => {
    const request = new Request("http://localhost/api/quote", { headers: { authorization: TOKEN } });
    expect(authorize(request)?.status).toBe(401);
  });

  it("throws a ConfigError when HIVE_API_TOKEN is unset, so the API fails closed", () => {
    delete process.env.HIVE_API_TOKEN;
    const request = new Request("http://localhost/api/quote", { headers: { authorization: "Bearer x" } });
    expect(() => authorize(request)).toThrow(ConfigError);
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
