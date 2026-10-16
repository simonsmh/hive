import { createGoogleFinanceCollectorHandler } from "./handler.ts";
import { createRestGoogleFinanceStore } from "./store.ts";

const FETCH_TIMEOUT_MS = 12_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createGoogleFinanceCollectorHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestGoogleFinanceStore({ supabaseUrl, serviceKey }),
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
