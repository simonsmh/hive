import { DEFAULT_YAHOO_BASE_URL, YahooClient } from "./core/yahoo.ts";
import { createYahooCollectorHandler } from "./handler.ts";
import { createRestYahooStore } from "./store.ts";

const FETCH_TIMEOUT_MS = 10_000;
const YAHOO_MAX_SLEEP_MS = 3_000;
const YAHOO_MIN_INTERVAL_MS = 300;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createYahooCollectorHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestYahooStore({ supabaseUrl, serviceKey }),
        client: new YahooClient({
          baseUrl: Deno.env.get("YAHOO_BASE_URL") ?? DEFAULT_YAHOO_BASE_URL,
          fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, YAHOO_MAX_SLEEP_MS))),
          minIntervalMs: YAHOO_MIN_INTERVAL_MS,
          maxRetries: 2,
          maxBackoffMs: YAHOO_MAX_SLEEP_MS,
        }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
