import { parseConditionalOrderInput } from "@hive/core";
import { authorize, handle, jsonResponse, readJsonBody } from "../../../lib/api";
import { cancelOrder, createOrder, listOrderViews } from "@/src/modules/orders/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    return jsonResponse({ orders: await listOrderViews() });
  });
}

/**
 * Creates a conditional order (reversal_long template). The evaluator primes it once the setup
 * (drawdown + oversold) is present and submits a real open through order-submit when a reversal
 * trigger confirms. Validation lives in @hive/core so the API and the evaluator agree on the shape.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const parsed = parseConditionalOrderInput(await readJsonBody(request), Date.now());
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

    return jsonResponse({ order: await createOrder(parsed.value) }, 201);
  });
}

/** Cancels an armed/primed order: body `{ id }`. Fired/expired/failed orders are history and stay. */
export async function PATCH(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const body = (await readJsonBody(request)) as { id?: unknown };
    if (typeof body.id !== "string" || body.id === "") {
      return jsonResponse({ error: "id is required" }, 400);
    }
    const order = await cancelOrder(body.id);
    if (!order) return jsonResponse({ error: "order not found or no longer cancellable" }, 404);

    return jsonResponse({ order });
  });
}
