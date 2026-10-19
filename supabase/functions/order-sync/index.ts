import { type OkxCredentials } from "./core/okx-signing.ts";
import { OkxTradeClient, TRADE_BASE_URL } from "./core/okx-trade.ts";
import type { PositionMode } from "./core/position.ts";
import { createOrderSyncHandler, type OrderSyncExchange } from "./handler.ts";
import { createRestOrderSyncStore } from "./store.ts";

const FETCH_TIMEOUT_MS = 10_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

/** Same switches as order-submit: the sweep only reconciles orders of the mode this deployment trades in. */
const demo = Deno.env.get("OKX_TRADE_DEMO") !== "false";
const mode: PositionMode = demo ? "demo" : "live";
const okxBaseUrl = Deno.env.get("OKX_BASE_URL") ?? TRADE_BASE_URL;

function tradeCredentials(): OkxCredentials | undefined {
  const apiKey = Deno.env.get("OKX_TRADE_API_KEY");
  const apiSecret = Deno.env.get("OKX_TRADE_API_SECRET");
  const passphrase = Deno.env.get("OKX_TRADE_API_PASSPHRASE");
  return apiKey && apiSecret && passphrase ? { apiKey, apiSecret, passphrase } : undefined;
}

function exchangeFrom(credentials: OkxCredentials): OrderSyncExchange {
  const fetchWithTimeout: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const trade = new OkxTradeClient({ baseUrl: okxBaseUrl, credentials, demo, fetchImpl: fetchWithTimeout });
  return {
    orderDetail: (instId, ordId) => trade.orderDetail(instId, ordId),
    algoDetail: (instId, algoId) => trade.algoDetail(instId, algoId),
    positions: (instId) => trade.positions(instId),
    pendingAlgos: (instId) => trade.pendingAlgos(instId),
  };
}

const credentials = tradeCredentials();

const handler =
  supabaseUrl && serviceKey && credentials
    ? createOrderSyncHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        mode,
        store: createRestOrderSyncStore({ supabaseUrl, serviceKey }),
        exchange: exchangeFrom(credentials),
      })
    : () =>
        Promise.resolve(
          Response.json(
            { error: "SUPABASE_URL, a service role key and OKX_TRADE_API_KEY/SECRET/PASSPHRASE must be set" },
            { status: 500 },
          ),
        );

Deno.serve(handler);
