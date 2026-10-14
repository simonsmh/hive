import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createRestEvaluatorStore } from "./store.ts";

const BASE = "https://project.supabase.co";
const SERVICE_KEY = "service-role-test-value";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (captured: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(captured);
    return Promise.resolve(respond(captured));
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

function store(respond: (captured: Captured) => Response) {
  const fake = fakeFetch(respond);
  return {
    ...fake,
    store: createRestEvaluatorStore({ supabaseUrl: `${BASE}/`, serviceKey: SERVICE_KEY, fetchImpl: fake.fetchImpl }),
  };
}

Deno.test("lists only enabled rules with the service role and maps them to handler rows", async () => {
  const rows = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "SNDK 10m move >=1%",
      symbol: "SNDK",
      source: "okx",
      kind: "pct_move",
      params: { interval: "1m", lookback: 10, minAbsPct: 1 },
      cooldown_seconds: 600,
      last_triggered_at: "2026-10-14T11:50:00.123456+00:00",
    },
  ];
  const { store: s, calls } = store(() => Response.json(rows));

  const rules = await s.listEnabledRules();

  const [call] = calls;
  ok(call?.url.startsWith(`${BASE}/rest/v1/alert_rules?`));
  ok(call?.url.includes("enabled=eq.true"));
  strictEqual(call?.method, "GET");
  strictEqual(call?.headers.apikey, SERVICE_KEY);
  strictEqual(call?.headers.authorization, `Bearer ${SERVICE_KEY}`);
  deepStrictEqual(rules, [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "SNDK 10m move >=1%",
      symbol: "SNDK",
      source: "okx",
      kind: "pct_move",
      params: { interval: "1m", lookback: 10, minAbsPct: 1 },
      cooldownSeconds: 600,
      lastTriggeredAtMs: Date.parse("2026-10-14T11:50:00.123Z"),
    },
  ]);
});

Deno.test("maps a rule that never fired to a null cooldown timestamp", async () => {
  const { store: s } = store(() =>
    Response.json([
      {
        id: "x",
        name: "n",
        symbol: "MU",
        source: "okx",
        kind: "pct_move",
        params: {},
        cooldown_seconds: 600,
        last_triggered_at: null,
      },
    ]),
  );

  const [rule] = await s.listEnabledRules();

  strictEqual(rule?.lastTriggeredAtMs, null);
});

Deno.test("reads confirmed candles newest-first and returns them ascending", async () => {
  const rows = [
    { ts: "2026-10-14T12:00:00+00:00", open: "102", high: "103", low: "101", close: "102.5", volume: "7", vol_ccy: "700" },
    { ts: "2026-10-14T11:59:00+00:00", open: "100", high: "101", low: "99", close: "100.5", volume: "5", vol_ccy: "500" },
  ];
  const { store: s, calls } = store(() => Response.json(rows));

  const candles = await s.confirmedCandles({ symbol: "SNDK", source: "okx", interval: "1m", limit: 2 });

  const [call] = calls;
  const query = new URL(call?.url ?? "").searchParams;
  strictEqual(query.get("symbol"), "eq.SNDK");
  strictEqual(query.get("source"), "eq.okx");
  strictEqual(query.get("interval"), "eq.1m");
  strictEqual(query.get("confirmed"), "eq.true");
  strictEqual(query.get("order"), "ts.desc");
  strictEqual(query.get("limit"), "2");
  deepStrictEqual(candles, [
    {
      ts: Date.parse("2026-10-14T11:59:00Z"),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 5,
      volCcy: 500,
      confirmed: true,
    },
    {
      ts: Date.parse("2026-10-14T12:00:00Z"),
      open: 102,
      high: 103,
      low: 101,
      close: 102.5,
      volume: 7,
      volCcy: 700,
      confirmed: true,
    },
  ]);
});

Deno.test("rejects a candle whose timestamp cannot be parsed", async () => {
  const { store: s } = store(() =>
    Response.json([{ ts: "not-a-time", open: 1, high: 1, low: 1, close: 1, volume: 0, vol_ccy: 0 }]),
  );

  let message = "";
  try {
    await s.confirmedCandles({ symbol: "SNDK", source: "okx", interval: "1m", limit: 1 });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  ok(message.includes("candle ts is not a timestamp"));
});

Deno.test("writes matches through the record RPC with the service role", async () => {
  const alerts = [
    {
      dedup_key: "rule:r:1",
      rule_id: "r",
      symbol: "SNDK",
      kind: "pct_move",
      severity: "warning" as const,
      payload: { pct: 1.2 },
    },
  ];
  const { store: s, calls } = store(() => Response.json({ inserted: 1, duplicates: 0 }));

  const result = await s.recordAlerts(alerts);

  const [call] = calls;
  strictEqual(call?.url, `${BASE}/rest/v1/rpc/hive_alert_evaluator_record`);
  strictEqual(call?.method, "POST");
  deepStrictEqual(call?.body, { p_alerts: alerts });
  deepStrictEqual(result, { inserted: 1, duplicates: 0 });
});

Deno.test("surfaces HTTP failures without echoing the service key", async () => {
  const { store: s } = store(() => new Response("permission denied", { status: 500 }));

  let message = "";
  try {
    await s.listEnabledRules();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  ok(message.includes("HTTP 500"));
  ok(!message.includes(SERVICE_KEY));
});
