import { type OkxCredentials } from "./core/okx-signing.ts";
import { OkxTradeClient, TRADE_BASE_URL } from "./core/okx-trade.ts";
import {
  createTrendEvaluatorHandler,
  type AccountState,
  type OrderSubmitter,
  type SubmitOutcome,
  type TrendExchange,
} from "./handler.ts";
import { createRestTrendStore } from "./store.ts";

const FETCH_TIMEOUT_MS = 5_000;
/** Longer than order-submit's own OKX timeout, so a slow but successful submit is not reported as unplaced. */
const SUBMIT_TIMEOUT_MS = 15_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
const orderToken = Deno.env.get("HIVE_ORDER_TOKEN");
const cronSecret = Deno.env.get("EDGE_CRON_SECRET");

/** Same switches as order-submit. Both functions must agree on OKX_TRADE_DEMO, because the evaluator acts through it. */
const demo = Deno.env.get("OKX_TRADE_DEMO") !== "false";
const liveEnabled = Deno.env.get("OKX_TRADE_LIVE_ENABLED") === "true";
const dryRun = Deno.env.get("TREND_EVALUATOR_DRY_RUN") === "true";
const okxBaseUrl = Deno.env.get("OKX_BASE_URL") ?? TRADE_BASE_URL;

function tradeCredentials(): OkxCredentials | undefined {
  const apiKey = Deno.env.get("OKX_TRADE_API_KEY");
  const apiSecret = Deno.env.get("OKX_TRADE_API_SECRET");
  const passphrase = Deno.env.get("OKX_TRADE_API_PASSPHRASE");
  return apiKey && apiSecret && passphrase ? { apiKey, apiSecret, passphrase } : undefined;
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Sends the intent to order-submit, so every gate, the idempotency window and the OKX path are the same as for a manual order. */
function orderSubmitterFrom(baseUrl: string, token: string): OrderSubmitter {
  const url = `${baseUrl.replace(/\/+$/, "")}/functions/v1/order-submit`;
  return {
    async submit(intent: Record<string, unknown>): Promise<SubmitOutcome> {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(intent),
          signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        });
      } catch (error) {
        return { httpStatus: null, status: "transport_error", reason: describeError(error), ordId: null, algoId: null, detail: null };
      }
      const parsed: unknown = await response.json().catch(() => null);
      const body = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      if (body === null || typeof body.status !== "string") {
        return { httpStatus: response.status, status: "unparsed_response", reason: `http_${response.status}`, ordId: null, algoId: null, detail: null };
      }
      return {
        httpStatus: response.status,
        status: body.status,
        reason: textOf(body.reason),
        ordId: textOf(body.ordId),
        algoId: textOf(body.algoId),
        detail: textOf(body.detail),
      };
    },
  };
}

const credentials = tradeCredentials();

function tradeClient(): OkxTradeClient {
  return new OkxTradeClient({
    baseUrl: okxBaseUrl,
    credentials: credentials!,
    demo,
    fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  });
}

const handler =
  supabaseUrl && serviceKey && orderToken && credentials && cronSecret
    ? createTrendEvaluatorHandler({
        cronSecret,
        mode: demo ? "demo" : "live",
        liveEnabled,
        dryRun,
        store: createRestTrendStore({ supabaseUrl, serviceKey }),
        exchange: {
          instrumentSpec: (instId) => tradeClient().instrumentSpec(instId),
          /**
           * Positions and pending algos come from the order-sync read endpoint (EDGE_CRON_SECRET),
           * which is the platform's one sanctioned live-account read path.
           */
          accountState: async (instId): Promise<AccountState> => {
            const url = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/order-sync?instId=${encodeURIComponent(instId)}`;
            const response = await fetch(url, {
              headers: { authorization: `Bearer ${cronSecret}` },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            const body: unknown = await response.json().catch(() => null);
            if (!response.ok || body === null || typeof body !== "object") {
              throw new Error(`order-sync read for ${instId} returned HTTP ${response.status}`);
            }
            const record = body as Record<string, unknown>;
            return {
              positions: Array.isArray(record.positions) ? (record.positions as AccountState["positions"]) : [],
              algos: Array.isArray(record.algos) ? (record.algos as AccountState["algos"]) : [],
            };
          },
          cancelAlgos: (items) => tradeClient().cancelAlgos(items),
        } satisfies TrendExchange,
        submitter: orderSubmitterFrom(supabaseUrl, orderToken),
      })
    : () =>
        Promise.resolve(
          Response.json(
            {
              error:
                "SUPABASE_URL, a service role key, HIVE_ORDER_TOKEN, EDGE_CRON_SECRET and OKX_TRADE_API_KEY/SECRET/PASSPHRASE must be set",
            },
            { status: 500 },
          ),
        );

Deno.serve(handler);
