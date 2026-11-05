import { createStrategyExecutorHandler, SUBMIT_TIMEOUT_MS, type OrderSubmitter, type SubmitOutcome } from "./handler.ts";
import { createRestExecutorStore } from "./store.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
const orderToken = Deno.env.get("HIVE_ORDER_TOKEN");

/** Same switches as order-submit. Both functions must agree on OKX_TRADE_DEMO, because the executor acts through it. */
const demo = Deno.env.get("OKX_TRADE_DEMO") !== "false";
const liveEnabled = Deno.env.get("OKX_TRADE_LIVE_ENABLED") === "true";

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
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

const handler =
  supabaseUrl && serviceKey && orderToken
    ? createStrategyExecutorHandler({
        cronSecret: Deno.env.get("EDGE_CRON_SECRET"),
        mode: demo ? "demo" : "live",
        liveEnabled,
        store: createRestExecutorStore({ supabaseUrl, serviceKey }),
        submitter: orderSubmitterFrom(supabaseUrl, orderToken),
      })
    : () =>
        Promise.resolve(
          Response.json(
            { error: "SUPABASE_URL, a service role key, and HIVE_ORDER_TOKEN must be set" },
            { status: 500 },
          ),
        );

Deno.serve(handler);
