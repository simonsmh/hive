import { type OkxCredentials } from "./core/okx-signing.ts";
import { OkxTradeClient, TRADE_BASE_URL } from "./core/okx-trade.ts";
import { createOrderSubmitHandler } from "./handler.ts";
import { createRestOrderStore } from "./store.ts";

const FETCH_TIMEOUT_MS = 5_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

/** Demo is the default. Only an explicit OKX_TRADE_DEMO=false trades live, and that also needs OKX_TRADE_LIVE_ENABLED=true. */
const demo = Deno.env.get("OKX_TRADE_DEMO") !== "false";
const liveEnabled = Deno.env.get("OKX_TRADE_LIVE_ENABLED") === "true";

/** All three values are needed to sign. Without them every request is refused rather than sent unsigned. */
function tradeCredentials(): OkxCredentials | undefined {
  const apiKey = Deno.env.get("OKX_TRADE_API_KEY");
  const apiSecret = Deno.env.get("OKX_TRADE_API_SECRET");
  const passphrase = Deno.env.get("OKX_TRADE_API_PASSPHRASE");
  return apiKey && apiSecret && passphrase ? { apiKey, apiSecret, passphrase } : undefined;
}

const credentials = tradeCredentials();

const handler =
  supabaseUrl && serviceKey && credentials
    ? createOrderSubmitHandler({
        orderToken: Deno.env.get("HIVE_ORDER_TOKEN"),
        mode: demo ? "demo" : "live",
        liveEnabled,
        store: createRestOrderStore({ supabaseUrl, serviceKey }),
        trade: new OkxTradeClient({
          baseUrl: Deno.env.get("OKX_BASE_URL") ?? TRADE_BASE_URL,
          credentials,
          demo,
          fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
        }),
      })
    : () =>
        Promise.resolve(
          Response.json(
            { error: "SUPABASE_URL, a service role key, and OKX_TRADE_API_KEY/SECRET/PASSPHRASE must be set" },
            { status: 500 },
          ),
        );

Deno.serve(handler);
