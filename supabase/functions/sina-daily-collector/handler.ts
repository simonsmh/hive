import { isAuthorized } from "./core/auth.ts";
import { runSinaCycle, type SinaTarget } from "./core/sina-cycle.ts";
import { toSinaCode, type SinaMarketData } from "./core/sina.ts";
import type { Candle, Source } from "./core/types.ts";

/** Edge Functions stop at 150s wall clock. The lease expires at that point, so a hung run cannot block later ticks. */
export const LEASE_SECONDS = 150;
/** No new symbol starts after this budget. Requests already in flight finish within their own timeouts. */
export const CYCLE_BUDGET_MS = 60_000;
export const CONCURRENCY = 2;
/** Sina throttles by address and does not say when a block ends, so a rate-limited run waits this long before retrying. */
export const RATE_LIMIT_BACKOFF_SECONDS = 600;

export interface SinaSymbolRecord {
  symbol: string;
  thsCode: string | null;
}

export interface SinaCollectorStore {
  listSymbols(): Promise<SinaSymbolRecord[]>;
  upsertCandles(symbol: string, source: Source, interval: "1D", candles: readonly Candle[]): Promise<number>;
  recordSourceSuccess(source: Source): Promise<void>;
  recordSourceFailure(source: Source, error: string): Promise<void>;
  beginRun(holder: string, leaseSeconds: number): Promise<boolean>;
  finishRun(holder: string, outcome: string, backoffSeconds: number, summary: Record<string, unknown>): Promise<void>;
}

export interface SinaCollectorDeps {
  cronSecret: string | undefined;
  store: SinaCollectorStore;
  client: SinaMarketData;
  now?: () => number;
  newHolder?: () => string;
  log?: (message: string) => void;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Symbols without a ths_code are skipped silently: most of symbol_map is
 * non-A-share (OKX perps, crypto, US stocks) and simply has no Sina daily
 * bar. A ths_code that does not fit the SH/SZ/BJ pattern is logged and
 * skipped, so one bad mapping does not stop the other symbols.
 */
export function toSinaTargets(records: readonly SinaSymbolRecord[], log: (message: string) => void): SinaTarget[] {
  const targets: SinaTarget[] = [];
  for (const record of records) {
    if (record.thsCode === null) continue;
    const sinaCode = toSinaCode(record.thsCode);
    if (sinaCode === null) {
      log(`ths_code for ${record.symbol} is not a mappable Sina code; skipping`);
      continue;
    }
    targets.push({ symbol: record.symbol, sinaCode });
  }
  return targets;
}

/**
 * Handles one pg_cron tick. Auth is checked before the database is touched.
 * A run takes a lease so overlapping ticks skip instead of double-polling,
 * and the lease is always released in `finally`, even when the run throws.
 * Only 1D candles are written, under source 'sina'; no quotes are touched.
 */
export function createSinaDailyCollectorHandler(deps: SinaCollectorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newHolder = deps.newHolder ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((message: string) => console.info(`[sina-daily-collector] ${message}`));

  return async (request: Request) => {
    if (request.method !== "POST") {
      return json(405, { error: "method not allowed" }, { allow: "POST" });
    }
    if (!deps.cronSecret) {
      return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    }
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
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
      const targets = toSinaTargets(await deps.store.listSymbols(), log);
      if (targets.length === 0) throw new Error("no enabled symbol has a mappable ths_code");

      const result = await runSinaCycle({
        client: deps.client,
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
        `cycle ${outcome} sina=${result.successes} failed=${result.failures} dbErrors=${result.writeErrors} skipped=${result.skippedTargets} ms=${now() - started}`,
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
