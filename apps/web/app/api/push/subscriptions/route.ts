import { authorizeSession, handle, jsonResponse, ParamError, readJsonBody } from "../../../../lib/api";
import { assertNoError, getDb } from "../../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;

interface PushSubscriptionBody {
  endpoint: string;
  p256dh: string;
  auth: string;
  filters: { news: boolean; alerts: boolean };
}

function parseFilters(raw: unknown): { news: boolean; alerts: boolean } {
  if (raw === undefined) return { news: true, alerts: true };
  if (typeof raw !== "object" || raw === null) throw new ParamError("filters must be an object");
  const record = raw as Record<string, unknown>;
  const news = record.news === undefined ? true : record.news;
  const alerts = record.alerts === undefined ? true : record.alerts;
  if (typeof news !== "boolean" || typeof alerts !== "boolean") {
    throw new ParamError("filters.news and filters.alerts must be booleans");
  }
  return { news, alerts };
}

function parseSubscriptionBody(body: unknown): PushSubscriptionBody {
  if (typeof body !== "object" || body === null) throw new ParamError("body must be a JSON object");
  const record = body as Record<string, unknown>;
  const endpoint = record.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new ParamError("endpoint is required");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ParamError("endpoint must be a valid URL");
  }
  if (url.protocol !== "https:") throw new ParamError("endpoint must be an https URL");

  const keys = typeof record.keys === "object" && record.keys !== null ? (record.keys as Record<string, unknown>) : {};
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (typeof p256dh !== "string" || p256dh.length === 0 || p256dh.length > MAX_KEY_LENGTH) {
    throw new ParamError("keys.p256dh is required");
  }
  if (typeof auth !== "string" || auth.length === 0 || auth.length > MAX_KEY_LENGTH) {
    throw new ParamError("keys.auth is required");
  }
  return { endpoint, p256dh, auth, filters: parseFilters(record.filters) };
}

/** Registers or updates the caller's browser push subscription (upsert by endpoint). */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorizeSession(request);
    if (denied) return denied;

    const body = parseSubscriptionBody(await readJsonBody(request));
    const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;
    const { error } = await getDb()
      .from("push_subscriptions")
      .upsert(
        {
          endpoint: body.endpoint,
          p256dh: body.p256dh,
          auth: body.auth,
          filters: body.filters,
          user_agent: userAgent,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" },
      );
    assertNoError(error);
    return jsonResponse({ ok: true }, 201);
  });
}

/** Removes the caller's browser push subscription by endpoint. */
export async function DELETE(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorizeSession(request);
    if (denied) return denied;

    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const endpoint = body.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
      throw new ParamError("endpoint is required");
    }
    const { error } = await getDb().from("push_subscriptions").delete().eq("endpoint", endpoint);
    assertNoError(error);
    return jsonResponse({ ok: true });
  });
}
