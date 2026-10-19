import { isAuthorized } from "./core/auth.ts";
import type { AlgoDetail, OrderDetail } from "./core/okx-trade.ts";
import type { PendingAlgo, PositionMode, PositionRow } from "./core/position.ts";

/** One row of the orders table that still needs its exchange state reconciled. */
export interface OrderRow {
  id: number;
  kind: "order" | "algo";
  instId: string;
  ordId: string | null;
  algoId: string | null;
  /** Stored placement type; for algo rows this is the OKX algo ordType ("conditional" | "oco"). */
  ordType: string | null;
  state: string | null;
  fillPx: number | null;
  fillSz: number | null;
}

export interface OrderSyncPatch {
  state?: string;
  fillPx?: number;
  fillSz?: number;
  lastSyncAt: string;
}

export interface OrderSyncStore {
  listPending(mode: PositionMode, limit: number): Promise<OrderRow[]>;
  applySync(id: number, patch: OrderSyncPatch): Promise<void>;
}

export interface OrderSyncExchange {
  orderDetail(instId: string, ordId: string): Promise<OrderDetail | null>;
  algoDetail(instId: string, algoId: string, ordType?: string | null): Promise<AlgoDetail | null>;
  positions(instId: string): Promise<PositionRow[]>;
  pendingAlgos(instId: string): Promise<PendingAlgo[]>;
}

/** Regular-order states after which the order never changes again. */
const FINAL_ORDER_STATES = new Set(["filled", "canceled", "mmp_canceled"]);

export interface OrderSyncDeps {
  /** EDGE_CRON_SECRET. Guards both the cron sweep (POST) and the read endpoint (GET). */
  cronSecret: string | undefined;
  mode: PositionMode;
  store: OrderSyncStore;
  exchange: OrderSyncExchange;
  now?: () => number;
}

/** Rows reconciled per sweep; orders are rare, so one page is plenty. */
export const PENDING_LIMIT = 100;

const INST_ID_PATTERN = /^[A-Z0-9]+-USDT-SWAP$/;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * Order state reconciliation. order-submit records placements in `orders` but never learns the outcome
 * (fill price, final state); this sweep polls OKX for every non-final row and writes the exchange state
 * back, so fills are visible in the database minutes after they happen. GET with ?instId= returns the
 * live position and its pending protection algos for operational reads.
 */
export function createOrderSyncHandler(deps: OrderSyncDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    if (request.method === "GET") {
      const instId = new URL(request.url).searchParams.get("instId") ?? "";
      if (!INST_ID_PATTERN.test(instId)) return json(400, { error: "instId must look like NVDA-USDT-SWAP" });
      try {
        const [positions, algos] = await Promise.all([
          deps.exchange.positions(instId),
          deps.exchange.pendingAlgos(instId),
        ]);
        return json(200, { instId, positions, algos });
      } catch (error) {
        return json(502, { error: `exchange read failed: ${describeError(error)}` });
      }
    }

    if (request.method !== "POST") return json(405, { error: "method not allowed" });

    let rows: OrderRow[];
    try {
      rows = await deps.store.listPending(deps.mode, PENDING_LIMIT);
    } catch (error) {
      return json(502, { error: `store read failed: ${describeError(error)}` });
    }

    const lastSyncAt = new Date(now()).toISOString();
    let updated = 0;
    let missing = 0;
    let failed = 0;
    let firstError: string | null = null;

    for (const row of rows) {
      try {
        if (row.kind === "order") {
          if (!row.ordId) throw new Error(`orders row ${row.id} has no ord_id`);
          const detail = await deps.exchange.orderDetail(row.instId, row.ordId);
          if (detail === null) {
            missing += 1;
            await deps.store.applySync(row.id, { lastSyncAt });
            continue;
          }
          const patch: OrderSyncPatch = { lastSyncAt };
          if (detail.state !== "" && detail.state !== row.state) patch.state = detail.state;
          if (detail.accFillSz > 0) {
            patch.fillSz = detail.accFillSz;
            if (detail.avgPx !== null) patch.fillPx = detail.avgPx;
          }
          await deps.store.applySync(row.id, patch);
          updated += 1;
        } else {
          if (!row.algoId) throw new Error(`orders row ${row.id} has no algo_id`);
          const detail = await deps.exchange.algoDetail(row.instId, row.algoId, row.ordType);
          if (detail === null) {
            missing += 1;
            await deps.store.applySync(row.id, { lastSyncAt });
            continue;
          }
          const patch: OrderSyncPatch = { lastSyncAt };
          // A triggered algo spawns a regular order; the algo's actualPx/actualSz are that order's
          // price and quantity, not its fills. Follow the child order, and only advance the algo
          // row to its final state once the child is final too — otherwise a still-working limit
          // child would freeze a partial (or empty) fill into a row the sweep stops visiting.
          let advanceState = true;
          if (detail.ordId !== null) {
            const child = await deps.exchange.orderDetail(row.instId, detail.ordId);
            if (child === null || !FINAL_ORDER_STATES.has(child.state)) {
              advanceState = false;
            } else if (child.accFillSz > 0) {
              patch.fillSz = child.accFillSz;
              if (child.avgPx !== null) patch.fillPx = child.avgPx;
            }
          }
          if (advanceState && detail.state !== "" && detail.state !== row.state) patch.state = detail.state;
          await deps.store.applySync(row.id, patch);
          updated += 1;
        }
      } catch (error) {
        failed += 1;
        if (firstError === null) firstError = describeError(error);
      }
    }

    return json(200, { status: "ok", mode: deps.mode, checked: rows.length, updated, missing, failed, error: firstError });
  };
}
