import { ALERT_SEVERITIES } from "@hive/core";
import { authorize, handle, jsonResponse } from "../../../lib/api";
import { parseBooleanFlag, parseInteger, parseOneOf, parseOptionalSymbol, parseToken } from "../../../lib/params";
import { toAlertView } from "@/src/modules/alerts/mapper";
import { listAlerts } from "@/src/modules/alerts/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KIND_PATTERN = /^[a-z_]{1,64}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const url = new URL(request.url);
    const kind = parseToken(url.searchParams.get("kind"), "kind", KIND_PATTERN, "[a-z_]{1,64}");
    const symbol = parseOptionalSymbol(url.searchParams.get("symbol"));
    const severity = parseOneOf(url.searchParams.get("severity"), "severity", ALERT_SEVERITIES);
    const unresolved = parseBooleanFlag(url.searchParams.get("unresolved"), "unresolved");
    const limit = parseInteger(url.searchParams.get("limit"), "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);

    const rows = await listAlerts({ kind, symbol, severity, unresolved, limit });
    return jsonResponse({ alerts: rows.map(toAlertView) });
  });
}
