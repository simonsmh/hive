import { authorize, handle, jsonResponse } from "../../../lib/api";
import { loadMaDeviationBoard } from "@/src/modules/ma-deviation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    return jsonResponse({ board: await loadMaDeviationBoard() });
  });
}
