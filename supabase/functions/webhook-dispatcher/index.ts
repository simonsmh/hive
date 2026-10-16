import { createRestDispatchStore } from "./store.ts";
import { createWebhookDispatcher } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createWebhookDispatcher({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestDispatchStore({ supabaseUrl, serviceKey }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
