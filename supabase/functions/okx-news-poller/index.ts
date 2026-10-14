import { createOkxNewsHandler, DEFAULT_OKX_NEWS_CONFIG } from "./handler.ts";
import { createRestOkxNewsStore } from "./store.ts";

const FETCH_TIMEOUT_MS = 8_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createOkxNewsHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestOkxNewsStore({ supabaseUrl, serviceKey }),
        config: { baseUrl: Deno.env.get("OKX_BASE_URL") ?? DEFAULT_OKX_NEWS_CONFIG.baseUrl },
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
