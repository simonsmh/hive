import { createOkxNewsHandler, DEFAULT_OKX_NEWS_CONFIG } from "./handler.ts";
import { createRestOkxNewsStore } from "./store.ts";
import type { OkxCredentials } from "./core/okx-signing.ts";

const FETCH_TIMEOUT_MS = 8_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

/** All three values are needed to sign. A partial set is ignored and the requests go out unsigned. */
function okxCredentials(): OkxCredentials | undefined {
  const apiKey = Deno.env.get("OKX_API_KEY");
  const apiSecret = Deno.env.get("OKX_API_SECRET");
  const passphrase = Deno.env.get("OKX_API_PASSPHRASE");
  return apiKey && apiSecret && passphrase ? { apiKey, apiSecret, passphrase } : undefined;
}

const handler =
  supabaseUrl && serviceKey
    ? createOkxNewsHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        store: createRestOkxNewsStore({ supabaseUrl, serviceKey }),
        config: {
          baseUrl: Deno.env.get("OKX_BASE_URL") ?? DEFAULT_OKX_NEWS_CONFIG.baseUrl,
          credentials: okxCredentials(),
        },
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      })
    : () =>
        Promise.resolve(
          Response.json({ error: "SUPABASE_URL and a service role key must be set" }, { status: 500 }),
        );

Deno.serve(handler);
