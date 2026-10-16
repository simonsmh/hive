import { resolvePollTargets, runPollCycle, type MarketDataSource } from "./core/collector.ts";
import type { OkxInstrument } from "./core/okx.ts";
import { isAuthorized } from "./core/auth.ts";
import type { EdgeCollectorStore } from "./store.ts";

/** Edge Functions stop at 150s wall clock. The lease expires at that point, so a hung run cannot block later ticks. */
export const LEASE_SECONDS = 150;
/** No new symbol starts after this budget. Requests already in flight finish within their own timeouts. */
export const CYCLE_BUDGET_MS = 60_000;
export const CONCURRENCY = 4;
export const RATE_LIMIT_BACKOFF_SECONDS = 300;
const INSTRUMENT_TTL_MS = 15 * 60_000;

export interface CollectorDeps {
  collectorSecret: string | undefined;
  store: EdgeCollectorStore;
  okx: MarketDataSource & { getInstruments(instType: string): Promise<OkxInstrument[]> };
  now?: () => number;
  newHolder?: () => string;
  log?: (message: string) => void;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Handles one pg_net tick. Auth is checked before anything touches the database. A run takes a
 * lease so overlapping 30-second ticks skip instead of double-polling, and the lease is always
 * released in `finally`, even when the run throws.
 */
export function createCollectorHandler(deps: CollectorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newHolder = deps.newHolder ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((message: string) => console.info(`[okx-collector] ${message}`));
  let instrumentCache: { fetchedAt: number; data: readonly OkxInstrument[] } | null = null;

  const getInstruments = async (): Promise<readonly OkxInstrument[]> => {
    if (instrumentCache && now() - instrumentCache.fetchedAt < INSTRUMENT_TTL_MS) return instrumentCache.data;
    const data = await deps.okx.getInstruments("SWAP");
    instrumentCache = { fetchedAt: now(), data };
    return data;
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(405, { error: "method not allowed" }, { allow: "POST" });
    }
    if (!deps.collectorSecret) {
      return json(500, { error: "COLLECTOR_SECRET is not configured" });
    }
    if (!isAuthorized(request.headers.get("authorization"), deps.collectorSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const holder = newHolder();
    const started = now();
    try {
      if (!(await deps.store.beginRun(holder, LEASE_SECONDS))) {
        return json(200, { status: "skipped", reason: "a run holds the lease or rate-limit backoff is active" });
      }
    } catch (error) {
      log(`could not start run: ${(error as Error).message}`);
      return json(500, { status: "error", error: "could not start run" });
    }

    let outcome = "error";
    let backoffSeconds = 0;
    let summary: Record<string, unknown> = {};
    try {
      const records = await deps.store.listSymbols();
      const targets = await resolvePollTargets(records, {
        getInstruments,
        saveInstId: (symbol, instId) => deps.store.setInstId(symbol, instId),
        log,
      });
      if (targets.length === 0) throw new Error("no symbol resolved to a live OKX instrument");

      const result = await runPollCycle({
        client: deps.okx,
        store: deps.store,
        targets,
        concurrency: CONCURRENCY,
        deadlineMs: started + CYCLE_BUDGET_MS,
        now,
        log,
      });

      if (result.rateLimited) {
        outcome = "rate_limited";
        backoffSeconds = RATE_LIMIT_BACKOFF_SECONDS;
      } else {
        outcome = result.failures > 0 || result.writeErrors > 0 || result.skippedTargets > 0 ? "degraded" : "ok";
      }
      summary = { ...result, targets: targets.length, durationMs: now() - started };
      log(
        `cycle ${outcome} okx=${result.successes} failed=${result.failures} dbErrors=${result.writeErrors} skipped=${result.skippedTargets} ms=${now() - started}`,
      );
      return json(200, { status: outcome, ...summary });
    } catch (error) {
      const message = (error as Error).message;
      summary = { error: message, durationMs: now() - started };
      log(`cycle error: ${message}`);
      return json(500, { status: "error", error: message });
    } finally {
      await deps.store.finishRun(holder, outcome, backoffSeconds, summary).catch((error: unknown) => {
        log(`could not release lease: ${(error as Error).message}`);
      });
    }
  };
}
