import { isAuthorized } from "./core/auth.ts";
import { type PositionMode, type SubscriptionInput, parseSubscriptionUpsert } from "./core/position.ts";

export const MAX_BODY_BYTES = 16_384;
const LIST_MODES: readonly PositionMode[] = ["demo", "live"];

export interface SubscriptionStore {
  /** Returns the id of the row written, or null when a disable found nothing to disable. */
  upsert(row: Record<string, unknown>): Promise<string | null>;
  list(mode: PositionMode): Promise<Record<string, unknown>[]>;
}

export interface SubscriptionsDeps {
  orderToken: string | undefined;
  store: SubscriptionStore;
  log?: (message: string) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** snake_case columns for the hive_position_subscription_upsert RPC. Defaults are applied by the parser, not here. */
export function toUpsertRow(input: SubscriptionInput): Record<string, unknown> {
  return {
    mode: input.mode,
    inst_id: input.instId,
    pos_side: input.posSide,
    direction: input.direction,
    td_mode: input.tdMode,
    lever: input.lever,
    entry_px: input.entryPx,
    sl_px: input.slPx,
    tp_px: input.tpPx,
    mid_px: input.midPx,
    theme: input.theme,
    theme_stop_cap_u: input.themeStopCapU,
    atr_len: input.atrLen,
    atr_mult: input.atrMult,
    amend_min_atr_frac: input.amendMinAtrFrac,
    half_reduce_frac: input.halfReduceFrac,
    dynamic_tp_enabled: input.dynamicTpEnabled,
    half_reduce_enabled: input.halfReduceEnabled,
    enabled: input.enabled,
    reset_state: input.resetState,
    note: input.note,
  };
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES ? null : text;
}

function parseMode(value: string | null): PositionMode | null {
  const mode = value ?? "live";
  return (LIST_MODES as readonly string[]).includes(mode) ? (mode as PositionMode) : null;
}

/**
 * Registers, updates or disables a position subscription (POST), and lists them (GET ?mode=live).
 * Both need HIVE_ORDER_TOKEN. Any USDT swap is accepted, and nothing is checked against a symbol list.
 */
export function createPositionSubscriptionsHandler(deps: SubscriptionsDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? ((message: string) => console.info(`[position-subscriptions] ${message}`));

  return async (request: Request): Promise<Response> => {
    if (!deps.orderToken) return json(500, { error: "HIVE_ORDER_TOKEN is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.orderToken)) {
      return json(401, { status: "rejected_auth", error: "unauthorized" });
    }

    if (request.method === "GET") {
      const mode = parseMode(new URL(request.url).searchParams.get("mode"));
      if (mode === null) return json(400, { status: "rejected_invalid", error: "mode must be demo or live" });
      try {
        return json(200, { status: "ok", mode, subscriptions: await deps.store.list(mode) });
      } catch (error) {
        log(`list failed: ${describeError(error)}`);
        return json(500, { status: "store_unavailable", error: describeError(error) });
      }
    }

    if (request.method !== "POST") return json(405, { error: "method not allowed" });

    const text = await readBody(request);
    if (text === null) return json(413, { status: "rejected_invalid", error: "body_too_large" });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json(400, { status: "rejected_invalid", error: "body is not JSON" });
    }

    const parsed = parseSubscriptionUpsert(raw);
    if (!parsed.ok) return json(400, { status: "rejected_invalid", error: parsed.error });
    const input = parsed.value;

    try {
      const id = await deps.store.upsert(toUpsertRow(input));
      if (!input.enabled) {
        log(`disabled mode=${input.mode} inst=${input.instId} posSide=${input.posSide} id=${id ?? "-"}`);
        return json(200, { status: "disabled", id, mode: input.mode, instId: input.instId, posSide: input.posSide });
      }
      log(`upserted mode=${input.mode} inst=${input.instId} posSide=${input.posSide} id=${id ?? "-"} reset=${input.resetState}`);
      return json(200, {
        status: "upserted",
        id,
        mode: input.mode,
        instId: input.instId,
        posSide: input.posSide,
        direction: input.direction,
        resetState: input.resetState,
      });
    } catch (error) {
      log(`upsert failed inst=${input.instId}: ${describeError(error)}`);
      return json(500, { status: "store_unavailable", error: describeError(error) });
    }
  };
}
