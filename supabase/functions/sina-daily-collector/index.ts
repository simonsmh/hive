import { DEFAULT_SINA_BASE_URL, SinaClient } from "./core/sina.ts";
import { createSinaDailyCollectorHandler } from "./handler.ts";
import { createRestSinaStore } from "./store.ts";

const FETCH_TIMEOUT_MS = 10_000;
const SINA_MAX_SLEEP_MS = 3_000;
const SINA_MIN_INTERVAL_MS = 200;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createSinaDailyCollectorHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestSinaStore({ supabaseUrl, serviceKey }),
        client: new SinaClient({
          baseUrl: Deno.env.get("SINA_BASE_URL") ?? DEFAULT_SINA_BASE_URL,
          fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, SINA_MAX_SLEEP_MS))),
          minIntervalMs: SINA_MIN_INTERVAL_MS,
          maxRetries: 2,
          maxBackoffMs: SINA_MAX_SLEEP_MS,
        }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
