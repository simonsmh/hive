import { isAuthorized } from "./core/auth.ts";
import type { CollectorStore, PollTarget } from "./core/collector.ts";
import { YAHOO_SYMBOL_PATTERN, type YahooMarketData } from "./core/yahoo.ts";
import { runYahooCycle } from "./core/yahoo-cycle.ts";

/** Edge Functions stop at 150s wall clock. The lease expires at that point, so a hung run cannot block later ticks. */
export const LEASE_SECONDS = 150;
/** No new symbol starts after this budget. Requests already in flight finish within their own timeouts. */
export const CYCLE_BUDGET_MS = 60_000;
export const CONCURRENCY = 2;
/** Yahoo throttles by address and does not say when a block ends, so a rate-limited run waits this long before retrying. */
export const RATE_LIMIT_BACKOFF_SECONDS = 600;

export interface YahooSymbolRecord {
  symbol: string;
  yahooSymbol: string | null;
}

export interface YahooCollectorStore extends CollectorStore {
  listSymbols(): Promise<YahooSymbolRecord[]>;
  beginRun(holder: string, leaseSeconds: number): Promise<boolean>;
  finishRun(holder: string, outcome: string, backoffSeconds: number, summary: Record<string, unknown>): Promise<void>;
}

export interface YahooCollectorDeps {
  cronSecret: string | undefined;
  store: YahooCollectorStore;
  client: YahooMarketData;
  now?: () => number;
  newHolder?: () => string;
  log?: (message: string) => void;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Symbols whose yahoo_symbol does not fit the allowed pattern are left out and logged, so the other symbols still poll. */
export function toYahooTargets(records: readonly YahooSymbolRecord[], log: (message: string) => void): PollTarget[] {
  const targets: PollTarget[] = [];
  for (const record of records) {
    if (record.yahooSymbol === null) continue;
    if (!YAHOO_SYMBOL_PATTERN.test(record.yahooSymbol)) {
      log(`yahoo_symbol for ${record.symbol} is not a valid Yahoo symbol; skipping`);
      continue;
    }
    targets.push({ symbol: record.symbol, instId: record.yahooSymbol });
  }
  return targets;
}

/**
 * Handles one pg_net tick. Auth is checked before the database is touched. A run takes a lease so overlapping ticks
 * skip instead of double-polling, and the lease is always released in `finally`, even when the run throws. The
 * daily-bar refresh state lives in this closure, so it persists across warm invocations of the same instance.
 */
export function createYahooCollectorHandler(deps: YahooCollectorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newHolder = deps.newHolder ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((message: string) => console.info(`[yahoo-collector] ${message}`));
  const dailyWrittenAt = new Map<string, number>();

  return async (request: Request): Promise<Response> => {
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
      const targets = toYahooTargets(await deps.store.listSymbols(), log);
      if (targets.length === 0) throw new Error("no enabled symbol has a valid yahoo_symbol");

      const result = await runYahooCycle({
        client: deps.client,
        store: deps.store,
        targets,
        dailyWrittenAt,
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
        `cycle ${outcome} yahoo=${result.successes} failed=${result.failures} dbErrors=${result.writeErrors} skipped=${result.skippedTargets} ms=${now() - started}`,
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
