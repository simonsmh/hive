import { createJin10Handler, DEFAULT_JIN10_CONFIG } from "./handler.ts";
import { createRestJin10Store } from "./store.ts";

const FETCH_TIMEOUT_MS = 10_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

const handler =
  supabaseUrl && serviceKey
    ? createJin10Handler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestJin10Store({ supabaseUrl, serviceKey }),
        config: {
          url: Deno.env.get("JIN10_FLASH_URL") ?? DEFAULT_JIN10_CONFIG.url,
          appId: Deno.env.get("JIN10_APP_ID") ?? DEFAULT_JIN10_CONFIG.appId,
          version: Deno.env.get("JIN10_VERSION") ?? DEFAULT_JIN10_CONFIG.version,
          referer: Deno.env.get("JIN10_REFERER") ?? DEFAULT_JIN10_CONFIG.referer,
          query: Deno.env.get("JIN10_QUERY") ?? DEFAULT_JIN10_CONFIG.query,
        },
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
