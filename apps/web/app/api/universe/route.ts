import { authorize, handle, jsonResponse } from "../../../lib/api";
import { loadUniverse } from "@/src/modules/symbols/universe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OKX perpetuals ranked by 24h turnover (top 100), each flagged when already tracked. */
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    return jsonResponse({ universe: await loadUniverse() });
  });
}
