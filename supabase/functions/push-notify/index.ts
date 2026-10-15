import { createPushNotifyHandler } from "./handler.ts";
import { createRestPushStore } from "./store.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
const vapidSubject = Deno.env.get("VAPID_SUBJECT");

const handler =
  supabaseUrl && serviceKey
    ? createPushNotifyHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        vapid:
          vapidPublic && vapidPrivate && vapidSubject
            ? { publicKey: vapidPublic, privateKey: vapidPrivate, subject: vapidSubject }
            : undefined,
        store: createRestPushStore({ supabaseUrl, serviceKey }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
