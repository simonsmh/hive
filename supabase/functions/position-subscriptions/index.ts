import { createPositionSubscriptionsHandler } from "./handler.ts";
import { createRestSubscriptionStore } from "./store.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createPositionSubscriptionsHandler({
        orderToken: Deno.env.get("HIVE_ORDER_TOKEN"),
        store: createRestSubscriptionStore({ supabaseUrl, serviceKey }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
