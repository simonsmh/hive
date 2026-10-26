import { authorize, handle, jsonResponse } from "../../../lib/api";
import { loadMarketBoard } from "@/src/modules/market/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    return jsonResponse({ board: await loadMarketBoard() });
  });
}
