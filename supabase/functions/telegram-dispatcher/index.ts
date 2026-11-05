import { createRestTelegramStore } from "./store.ts";
import { createTelegramDispatcher } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createTelegramDispatcher({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestTelegramStore({ supabaseUrl, serviceKey }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
