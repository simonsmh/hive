import type { PositionMode } from "./core/position.ts";
import type { OrderRow, OrderSyncPatch, OrderSyncStore } from "./handler.ts";

const MAX_BODY_IN_ERROR = 300;

/**
 * States the sweep still has to reconcile. Regular orders: accepted (as written at placement), live,
 * partially_filled. Algo orders: accepted, live, pause (can resume), partially_effective. Final states
 * (filled, canceled, mmp_canceled, effective, partially_failed, order_failed) never change again and
 * drop out of the sweep on their own.
 */
const PENDING_STATES = "in.(accepted,live,partially_filled,partially_effective,pause)";

export interface RestStoreOptions {
  supabaseUrl: string;
  /** Service role key. Only sent to the project's own REST endpoint. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

interface OrderDbRow {
  id: number;
  kind: "order" | "algo";
  inst_id: string;
  ord_id: string | null;
  algo_id: string | null;
  ord_type: string | null;
  state: string | null;
  fill_px: number | string | null;
  fill_sz: number | string | null;
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toOrderRow(row: OrderDbRow): OrderRow {
  return {
    id: row.id,
    kind: row.kind,
    instId: row.inst_id,
    ordId: row.ord_id,
    algoId: row.algo_id,
    ordType: row.ord_type,
    state: row.state,
    fillPx: numberOrNull(row.fill_px),
    fillSz: numberOrNull(row.fill_sz),
  };
}

function syncColumns(patch: OrderSyncPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = { last_sync_at: patch.lastSyncAt };
  if (patch.state !== undefined) columns.state = patch.state;
  if (patch.fillPx !== undefined) columns.fill_px = patch.fillPx;
  if (patch.fillSz !== undefined) columns.fill_sz = patch.fillSz;
  return columns;
}

/** PostgREST-backed store over the orders table, written by order-submit at placement time. */
export function createRestOrderSyncStore(options: RestStoreOptions): OrderSyncStore {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(method: "GET" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers.prefer = "return=minimal";
    }
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostgREST ${method} ${path.split("?")[0]} returned HTTP ${response.status}: ${text.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    async listPending(mode: PositionMode, limit: number): Promise<OrderRow[]> {
      const query = new URLSearchParams({
        select: "id,kind,inst_id,ord_id,algo_id,ord_type,state,fill_px,fill_sz",
        mode: `eq.${mode}`,
        state: PENDING_STATES,
        order: "last_sync_at.asc.nullsfirst,created_at.asc",
        limit: String(limit),
      });
      const rows = (await request("GET", `/rest/v1/orders?${query.toString()}`)) as OrderDbRow[];
      return rows.map(toOrderRow);
    },

    async applySync(id: number, patch: OrderSyncPatch): Promise<void> {
      const query = new URLSearchParams({ id: `eq.${id}` });
      await request("PATCH", `/rest/v1/orders?${query.toString()}`, syncColumns(patch));
    },
  };
}
