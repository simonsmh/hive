import { parseTrendStrategyInput } from "@hive/core";
import { authorize, handle, jsonResponse, readJsonBody } from "../../../lib/api";
import { cancelTrendStrategy, createTrendStrategy, listTrendViews } from "@/src/modules/trend/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    return jsonResponse({ strategies: await listTrendViews() });
  });
}

/**
 * Creates a trend_follow strategy instance. runMode is required in the body: "shadow" instances run
 * the full state machine against live bars and write events but never submit an order; "live"
 * instances open/pyramid/exit through order-submit when the mechanical trigger fires. Validation
 * lives in @hive/core so the API and the evaluator agree on the shape.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const parsed = parseTrendStrategyInput(await readJsonBody(request), Date.now());
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

    return jsonResponse({ strategy: await createTrendStrategy(parsed.value) }, 201);
  });
}

/** Cancels an armed/active instance: body `{ id }`. Terminal instances are history and stay. */
export async function PATCH(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const body = (await readJsonBody(request)) as { id?: unknown };
    if (typeof body.id !== "string" || body.id === "") {
      return jsonResponse({ error: "id is required" }, 400);
    }
    const strategy = await cancelTrendStrategy(body.id);
    if (!strategy) return jsonResponse({ error: "strategy not found or no longer cancellable" }, 404);

    return jsonResponse({ strategy });
  });
}
