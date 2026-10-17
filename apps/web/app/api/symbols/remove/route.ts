import { parseSymbolListInput } from "@hive/core";
import { authorize, handle, jsonResponse, readJsonBody } from "../../../../lib/api";
import { removeSymbols } from "@/src/modules/symbols/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Batch delete of symbol_map rows: body `{ symbols: [...] }`.
 * A POST (not DELETE) so the batch travels in a JSON body everywhere.
 * Historical candles are intentionally kept; retention ages them out.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const symbols = parseSymbolListInput(await readJsonBody(request));
    const removed = await removeSymbols(symbols);

    return jsonResponse({ removed });
  });
}
