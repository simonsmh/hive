import { parseSubscriptionInput } from "@hive/core";
import { authorize, handle, jsonResponse, readJsonBody } from "../../../../lib/api";
import { parseUuid } from "../../../../lib/params";
import { generateSigningSecret } from "@/src/modules/webhooks/mapper";
import { removeSubscription, writeSubscription } from "@/src/modules/webhooks/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return handle(async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const id = parseUuid((await context.params).id, "id");
    const input = parseSubscriptionInput(await readJsonBody(request), { requireAll: false });

    const rotated = input.secret === null && input.rotate_secret;
    const secret = input.secret ?? (rotated ? generateSigningSecret() : null);

    const subscription = await writeSubscription({
      id,
      agent_name: input.agent_name,
      url: input.url,
      secret,
      auth_token: input.auth_token,
      event_types: input.event_types,
      filters: input.filters,
      enabled: input.enabled,
    });

    return jsonResponse(rotated ? { subscription, signing_secret: secret } : { subscription });
  });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return handle(async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const id = parseUuid((await context.params).id, "id");
    await removeSubscription(id);

    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}
