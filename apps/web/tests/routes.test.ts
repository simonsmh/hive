import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getQuote } from "../app/api/quote/route";
import { GET as getCandles } from "../app/api/candles/route";
import { GET as getAtr } from "../app/api/atr/route";
import { GET as getHealth } from "../app/api/health/route";
import { GET as listWebhooks, POST as createWebhook } from "../app/api/webhooks/route";
import { DELETE as deleteWebhook, PATCH as patchWebhook } from "../app/api/webhooks/[id]/route";
import { GET as listDeliveries } from "../app/api/webhook-deliveries/route";
import { GET as listAlerts } from "../app/api/alerts/route";
import { GET as listNews } from "../app/api/news/route";

vi.mock("server-only", () => ({}));

const TOKEN = "route-test-token-0123456789abcdef";
const base = "http://localhost";

// Routes are exercised without a database: auth and parameter validation must
// reject before any Supabase call is made.
describe("API auth and validation (no database)", () => {
  beforeEach(() => {
    process.env.HIVE_API_TOKEN = TOKEN;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    delete process.env.HIVE_API_TOKEN;
  });

  const auth = { authorization: `Bearer ${TOKEN}` };
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it.each([
    ["quote", () => getQuote(new Request(`${base}/api/quote?symbols=NVDA`))],
    ["candles", () => getCandles(new Request(`${base}/api/candles?symbol=NVDA&interval=1m`))],
    ["atr", () => getAtr(new Request(`${base}/api/atr?symbol=XAU`))],
    ["health", () => getHealth(new Request(`${base}/api/health`))],
    ["webhooks list", () => listWebhooks(new Request(`${base}/api/webhooks`))],
    ["webhooks create", () => createWebhook(new Request(`${base}/api/webhooks`, { method: "POST", body: "{}" }))],
    [
      "webhooks patch",
      () => patchWebhook(new Request(`${base}/api/webhooks/x`, { method: "PATCH", body: "{}" }), ctx("x")),
    ],
    ["webhooks delete", () => deleteWebhook(new Request(`${base}/api/webhooks/x`, { method: "DELETE" }), ctx("x"))],
    ["webhook deliveries", () => listDeliveries(new Request(`${base}/api/webhook-deliveries`))],
    ["alerts", () => listAlerts(new Request(`${base}/api/alerts`))],
    ["news", () => listNews(new Request(`${base}/api/news`))],
  ])("%s rejects requests without a bearer token", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(401);
  });

  it("rejects a wrong bearer token on quote", async () => {
    const response = await getQuote(
      new Request(`${base}/api/quote?symbols=NVDA`, { headers: { authorization: "Bearer wrong" } }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 for missing symbols once authenticated", async () => {
    const response = await getQuote(new Request(`${base}/api/quote`, { headers: auth }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "symbols is required (comma-separated)" });
  });

  it("returns 400 for an unsupported candle interval once authenticated", async () => {
    const response = await getCandles(new Request(`${base}/api/candles?symbol=NVDA&interval=2m`, { headers: auth }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an out-of-range ATR period once authenticated", async () => {
    const response = await getAtr(new Request(`${base}/api/atr?symbol=XAU&period=0`, { headers: auth }));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed subscription body with 400 and the list of problems", async () => {
    const response = await createWebhook(
      new Request(`${base}/api/webhooks`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ agent_name: "Bad Name", url: "http://insecure.example.com", filters: { colour: "red" } }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; problems: string[] };
    expect(body.error).toBe("invalid subscription");
    expect(body.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 400 for malformed JSON on create", async () => {
    const response = await createWebhook(new Request(`${base}/api/webhooks`, { method: "POST", headers: auth, body: "{nope" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "body must be valid JSON" });
  });

  it("returns 400 for a non-UUID subscription id on patch and delete", async () => {
    const patch = await patchWebhook(
      new Request(`${base}/api/webhooks/not-a-uuid`, { method: "PATCH", headers: auth, body: "{}" }),
      ctx("not-a-uuid"),
    );
    expect(patch.status).toBe(400);
    const remove = await deleteWebhook(new Request(`${base}/api/webhooks/not-a-uuid`, { method: "DELETE", headers: auth }), ctx("not-a-uuid"));
    expect(remove.status).toBe(400);
  });

  it("rejects a bearer token with spaces or too short on create and update, before any database call", async () => {
    const badToken = JSON.stringify({ agent_name: "grok-bot", url: "https://grok.example.com/hook", auth_token: "has space" });
    const create = await createWebhook(new Request(`${base}/api/webhooks`, { method: "POST", headers: auth, body: badToken }));
    expect(create.status).toBe(400);
    expect((await create.json()).problems).toEqual(["auth_token must be 16-512 visible ASCII characters without spaces"]);
    const patch = await patchWebhook(
      new Request(`${base}/api/webhooks/11111111-2222-3333-4444-555555555555`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ auth_token: "short" }),
      }),
      ctx("11111111-2222-3333-4444-555555555555"),
    );
    expect(patch.status).toBe(400);
  });

  it("rejects an unknown delivery status and an out-of-range limit", async () => {
    const status = await listDeliveries(new Request(`${base}/api/webhook-deliveries?status=exploded`, { headers: auth }));
    expect(status.status).toBe(400);
    const limit = await listDeliveries(new Request(`${base}/api/webhook-deliveries?limit=500`, { headers: auth }));
    expect(limit.status).toBe(400);
    const agent = await listDeliveries(new Request(`${base}/api/webhook-deliveries?agent=Bad%20Agent`, { headers: auth }));
    expect(agent.status).toBe(400);
  });

  it("rejects a wrong bearer token on the alerts and news reads", async () => {
    const wrong = { headers: { authorization: "Bearer wrong" } };
    expect((await listAlerts(new Request(`${base}/api/alerts`, wrong))).status).toBe(401);
    expect((await listNews(new Request(`${base}/api/news`, wrong))).status).toBe(401);
  });

  it("rejects invalid alert filters once authenticated", async () => {
    const cases = [
      "kind=Bad-Kind",
      "symbol=../x",
      "severity=urgent",
      "unresolved=yes",
      "limit=0",
      "limit=201",
    ];
    for (const query of cases) {
      const response = await listAlerts(new Request(`${base}/api/alerts?${query}`, { headers: auth }));
      expect(response.status, query).toBe(400);
    }
  });

  it("rejects invalid news filters once authenticated", async () => {
    const cases = [
      "source=binance",
      "q=a,b",
      "q=(x)",
      "q=" + "x".repeat(101),
      "since=yesterday",
      "limit=500",
    ];
    for (const query of cases) {
      const response = await listNews(new Request(`${base}/api/news?${query}`, { headers: auth }));
      expect(response.status, query).toBe(400);
    }
  });

  it("returns 500 (fail closed) when the token is not configured", async () => {
    delete process.env.HIVE_API_TOKEN;
    const response = await getHealth(new Request(`${base}/api/health`, { headers: auth }));
    expect(response.status).toBe(500);
  });
});
