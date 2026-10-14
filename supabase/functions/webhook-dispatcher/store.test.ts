import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createRestDispatchStore } from "./store.ts";

function fakeRpc(rows: unknown[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test("claim maps the decrypted bearer token and leaves it null when absent", async () => {
  const { fetchImpl, calls } = fakeRpc([
    {
      delivery_id: 3,
      agent_name: "grok-bot",
      url: "https://grok.example.com/hook",
      secret: "signing-secret-0123456789abcdef",
      auth_token: "grok-routine-key-0123456789ab",
      event_type: "news",
      payload: { type: "news" },
      attempts: 1,
      max_attempts: 6,
    },
    {
      delivery_id: 4,
      agent_name: "plain-bot",
      url: "https://plain.example.com/hook",
      secret: "signing-secret-0123456789abcdef",
      auth_token: null,
      event_type: "alert",
      payload: { type: "alert" },
      attempts: 2,
      max_attempts: 6,
    },
  ]);
  const store = createRestDispatchStore({ supabaseUrl: "https://project.supabase.co", serviceKey: "service-key", fetchImpl });
  const due = await store.claim(20, 120);

  strictEqual(calls[0]!.url, "https://project.supabase.co/rest/v1/rpc/hive_webhook_claim");
  deepStrictEqual(calls[0]!.body, { p_limit: 20, p_lease_seconds: 120 });
  strictEqual(due[0]!.authToken, "grok-routine-key-0123456789ab");
  strictEqual(due[1]!.authToken, null);
  strictEqual(due[1]!.attempts, 2);
});

Deno.test("claim maps priority, event time and stale threshold, and treats an unknown priority as critical", async () => {
  const row = (priority: string) => ({
    delivery_id: 5,
    agent_name: "grok-bot",
    url: "https://grok.example.com/hook",
    secret: "signing-secret-0123456789abcdef",
    auth_token: null,
    event_type: "alert",
    payload: { type: "alert", kind: "fill" },
    attempts: 1,
    max_attempts: 6,
    priority,
    event_ts: "2026-10-14T12:00:00+00:00",
    created_at: "2026-10-14T12:00:01+00:00",
    stale_after_seconds: 60,
  });
  const { fetchImpl } = fakeRpc([row("bulk"), row("critical"), row("surprise")]);
  const store = createRestDispatchStore({ supabaseUrl: "https://project.supabase.co", serviceKey: "service-key", fetchImpl });
  const due = await store.claim(20, 120);
  deepStrictEqual(due.map((d) => d.priority), ["bulk", "critical", "critical"]);
  strictEqual(due[0]!.eventTs, "2026-10-14T12:00:00+00:00");
  strictEqual(due[0]!.createdAt, "2026-10-14T12:00:01+00:00");
  strictEqual(due[0]!.staleAfterSeconds, 60);
});

Deno.test("release posts the claimed ids to hive_webhook_release and skips the call when there are none", async () => {
  const { fetchImpl, calls } = fakeRpc([]);
  const store = createRestDispatchStore({ supabaseUrl: "https://project.supabase.co", serviceKey: "service-key", fetchImpl });
  await store.release([]);
  strictEqual(calls.length, 0);
  await store.release([7, 9]);
  strictEqual(calls[0]!.url, "https://project.supabase.co/rest/v1/rpc/hive_webhook_release");
  deepStrictEqual(calls[0]!.body, { p_delivery_ids: [7, 9] });
});
