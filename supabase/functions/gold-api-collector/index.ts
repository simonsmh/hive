import { createGoldApiCollectorHandler, createHttpGoldApiClient, FETCH_TIMEOUT_MS } from "./handler.ts";
import { createRestGoldApiStore } from "./store.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createGoldApiCollectorHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestGoldApiStore({ supabaseUrl, serviceKey }),
        client: createHttpGoldApiClient({ timeoutMs: FETCH_TIMEOUT_MS }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
