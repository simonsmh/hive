import { createBlockBeatsHandler } from "./handler.ts";
import { createRestBlockBeatsStore } from "./store.ts";
import { DEFAULT_BLOCKBEATS_CONFIG } from "./api.ts";

const FETCH_TIMEOUT_MS = 10_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createBlockBeatsHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestBlockBeatsStore({ supabaseUrl, serviceKey }),
        config: {
          baseUrl: Deno.env.get("BLOCKBEATS_API_BASE") ?? DEFAULT_BLOCKBEATS_CONFIG.baseUrl,
          appKey: Deno.env.get("BLOCKBEATS_APP_KEY") ?? DEFAULT_BLOCKBEATS_CONFIG.appKey,
          appSecret: Deno.env.get("BLOCKBEATS_APP_SECRET") ?? DEFAULT_BLOCKBEATS_CONFIG.appSecret,
        },
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
