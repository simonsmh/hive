import { NEWS_SOURCES } from "@hive/core";
import { authorize, handle, jsonResponse } from "../../../lib/api";
import { parseInteger, parseOneOf, parseSearchTerm, parseTimestamp } from "../../../lib/params";
import { toNewsItemApiView } from "@/src/modules/news/mapper";
import { listNewsItems } from "@/src/modules/news/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const url = new URL(request.url);
    const source = parseOneOf(url.searchParams.get("source"), "source", NEWS_SOURCES);
    const q = parseSearchTerm(url.searchParams.get("q"), "q");
    const since = parseTimestamp(url.searchParams.get("since"), "since");
    const limit = parseInteger(url.searchParams.get("limit"), "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);

    const rows = await listNewsItems({ source, q, since, limit });
    return jsonResponse({ items: rows.map(toNewsItemApiView) });
  });
}
