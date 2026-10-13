import { authorize, handle, jsonResponse, ParamError } from "../../../lib/api";
import { parseInteger } from "../../../lib/params";
import { DELIVERY_STATUSES } from "@/src/modules/webhooks/mapper";
import { listDeliveryViews } from "@/src/modules/webhooks/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const agent = url.searchParams.get("agent");
    if (status !== null && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
      throw new ParamError(`status must be one of ${DELIVERY_STATUSES.join(", ")}`);
    }
    if (agent !== null && !AGENT_NAME_PATTERN.test(agent)) {
      throw new ParamError("agent must match [a-z0-9_-]{1,64}");
    }
    const limit = parseInteger(url.searchParams.get("limit"), "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);

    const deliveries = await listDeliveryViews({ status, agentName: agent, limit });
    return jsonResponse({ deliveries });
  });
}
