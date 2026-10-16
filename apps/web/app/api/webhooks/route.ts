import { parseSubscriptionInput } from "@hive/core";
import { authorize, handle, jsonResponse, readJsonBody } from "../../../lib/api";
import { generateSigningSecret } from "@/src/modules/webhooks/mapper";
import { listSubscriptionViews, writeSubscription } from "@/src/modules/webhooks/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    return jsonResponse({ subscriptions: await listSubscriptionViews() });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const input = parseSubscriptionInput(await readJsonBody(request), { requireAll: true });
    const generated = input.secret === null;
    const secret = input.secret ?? generateSigningSecret();

    const subscription = await writeSubscription({
      id: null,
      agent_name: input.agent_name,
      url: input.url,
      secret,
      auth_token: input.auth_token,
      event_types: input.event_types,
      filters: input.filters,
      enabled: input.enabled,
    });

    return jsonResponse(
      generated ? { subscription, signing_secret: secret } : { subscription },
      201,
    );
  });
}
