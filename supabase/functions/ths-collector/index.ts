import { DEFAULT_THS_BASE_URL, ThsClient } from "./core/ths.ts";
import { createThsCollectorHandler } from "./handler.ts";
import { createRestThsStore } from "./store.ts";

const THS_REQUEST_TIMEOUT_MS = 6_000;
const THS_MAX_SLEEP_MS = 4_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
const apiKey = Deno.env.get("HITHINK_FINANCE_API_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createThsCollectorHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        apiKey,
        store: createRestThsStore({ supabaseUrl, serviceKey }),
        client: new ThsClient({
          apiKey: apiKey ?? "",
          baseUrl: Deno.env.get("THS_BASE_URL") ?? DEFAULT_THS_BASE_URL,
          fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(THS_REQUEST_TIMEOUT_MS) }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, THS_MAX_SLEEP_MS))),
          maxRetries: 3,
          maxBackoffMs: THS_MAX_SLEEP_MS,
        }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
