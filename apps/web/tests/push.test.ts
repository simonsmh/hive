import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteSubscription, POST as createSubscription } from "../app/api/push/subscriptions/route";
import { createSessionToken, SESSION_COOKIE } from "../src/modules/auth/session";

vi.mock("server-only", () => ({}));

const API_TOKEN = "push-test-api-token-0123456789";
const SESSION_SECRET = "p".repeat(40);
const base = "http://localhost";

const VALID_BODY = {
  endpoint: "https://push.example.net/send/abc",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
  filters: { news: true, alerts: false },
};

async function sessionHeaders(): Promise<{ cookie: string }> {
  return { cookie: `${SESSION_COOKIE}=${await createSessionToken(SESSION_SECRET)}` };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${base}/api/push/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// The database env is deliberately absent: requests that pass auth and validation
// surface as a 500 from the data layer, which is what distinguishes them from the
// 401/400 rejections asserted below.
describe("push subscriptions API (no database)", () => {
  beforeEach(() => {
    process.env.HIVE_API_TOKEN = API_TOKEN;
    process.env.HIVE_SESSION_SECRET = SESSION_SECRET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    delete process.env.HIVE_API_TOKEN;
    delete process.env.HIVE_SESSION_SECRET;
  });

  it("rejects requests without a session", async () => {
    expect((await createSubscription(post(VALID_BODY))).status).toBe(401);
    const del = new Request(`${base}/api/push/subscriptions`, { method: "DELETE", body: "{}" });
    expect((await deleteSubscription(del)).status).toBe(401);
  });

  it("rejects the API bearer token: subscriptions are session-only", async () => {
    const response = await createSubscription(post(VALID_BODY, { authorization: `Bearer ${API_TOKEN}` }));
    expect(response.status).toBe(401);
  });

  it("validates the body before touching the database", async () => {
    const headers = await sessionHeaders();
    expect((await createSubscription(post({}, headers))).status).toBe(400);
    expect((await createSubscription(post({ ...VALID_BODY, endpoint: "http://insecure.example/x" }, headers))).status).toBe(400);
    expect((await createSubscription(post({ ...VALID_BODY, keys: { p256dh: "" } }, headers))).status).toBe(400);
    expect((await createSubscription(post({ ...VALID_BODY, filters: { news: "yes" } }, headers))).status).toBe(400);
  });

  it("accepts a well-formed subscription and reaches the data layer", async () => {
    const headers = await sessionHeaders();
    expect((await createSubscription(post(VALID_BODY, headers))).status).toBe(500);
  });

  it("DELETE validates the endpoint after auth", async () => {
    const headers = await sessionHeaders();
    const empty = new Request(`${base}/api/push/subscriptions`, { method: "DELETE", headers, body: "{}" });
    expect((await deleteSubscription(empty)).status).toBe(400);
    const valid = new Request(`${base}/api/push/subscriptions`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ endpoint: VALID_BODY.endpoint }),
    });
    expect((await deleteSubscription(valid)).status).toBe(500);
  });
});
