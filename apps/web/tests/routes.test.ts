import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getQuote } from "../app/api/quote/route";
import { GET as getCandles } from "../app/api/candles/route";
import { GET as getAtr } from "../app/api/atr/route";
import { GET as getHealth } from "../app/api/health/route";

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

  it.each([
    ["quote", () => getQuote(new Request(`${base}/api/quote?symbols=NVDA`))],
    ["candles", () => getCandles(new Request(`${base}/api/candles?symbol=NVDA&interval=1m`))],
    ["atr", () => getAtr(new Request(`${base}/api/atr?symbol=XAU`))],
    ["health", () => getHealth(new Request(`${base}/api/health`))],
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

  it("returns 500 (fail closed) when the token is not configured", async () => {
    delete process.env.HIVE_API_TOKEN;
    const response = await getHealth(new Request(`${base}/api/health`, { headers: auth }));
    expect(response.status).toBe(500);
  });
});
