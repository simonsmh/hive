import { DEFAULT_OKX_BASE_URL, OkxClient } from "./core/okx.ts";
import { createCollectorHandler } from "./handler.ts";
import { createRestStore } from "./store.ts";

const OKX_REQUEST_TIMEOUT_MS = 10_000;
const OKX_MAX_SLEEP_MS = 3_000;
const OKX_MIN_INTERVAL_MS = 120;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createCollectorHandler({
        collectorSecret: Deno.env.get("COLLECTOR_SECRET"),
        store: createRestStore({ supabaseUrl, serviceKey }),
        okx: new OkxClient({
          baseUrl: Deno.env.get("OKX_BASE_URL") ?? DEFAULT_OKX_BASE_URL,
          fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(OKX_REQUEST_TIMEOUT_MS) }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, OKX_MAX_SLEEP_MS))),
          minIntervalMs: OKX_MIN_INTERVAL_MS,
          maxRetries: 2,
          maxBackoffMs: OKX_MAX_SLEEP_MS,
        }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
