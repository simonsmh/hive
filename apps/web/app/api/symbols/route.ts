import { parseSymbolAddInput, parseSymbolListInput } from "@hive/core";
import { authorize, handle, jsonResponse, readJsonBody } from "../../../lib/api";
import { addSymbols, listSymbolViews, setSymbolsEnabled } from "@/src/modules/symbols/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    return jsonResponse({ symbols: await listSymbolViews() });
  });
}

/**
 * Adds symbols to the tracked set (batch). Each entry is a bare symbol or a
 * full mapping; omitted OKX/Yahoo mappings are resolved server-side.
 * Existing symbols are merged and re-enabled rather than rejected.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const items = parseSymbolAddInput(await readJsonBody(request));
    const results = await addSymbols(items);

    return jsonResponse({ results }, 201);
  });
}

/** Batch enable/disable without deleting rows: body `{ symbols: [...], enabled: boolean }`. */
export async function PATCH(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const body = (await readJsonBody(request)) as { symbols?: unknown; enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }
    const symbols = parseSymbolListInput(body);
    const updated = await setSymbolsEnabled(symbols, body.enabled);

    return jsonResponse({ symbols: updated });
  });
}
