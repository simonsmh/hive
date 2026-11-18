import { isAuthorized } from "./core/auth.ts";
import { runSinaIntradayCycle, type SinaIntradayTarget } from "./core/sina-intraday-cycle.ts";
import { toSinaCode, type SinaIntradayData } from "./core/sina.ts";
import type { Candle, Source } from "./core/types.ts";

/** Edge Functions stop at 150s wall clock. The lease expires at that point, so a hung run cannot block later ticks. */
export const LEASE_SECONDS = 150;
/** No new symbol starts after this budget. Requests already in flight finish within their own timeouts. */
export const CYCLE_BUDGET_MS = 60_000;
export const CONCURRENCY = 1;
/** Sina throttles by address and does not say when a block ends, so a rate-limited run waits this long before retrying. */
export const RATE_LIMIT_BACKOFF_SECONDS = 600;

/**
 * Collected symbols, hard-coded on purpose: only these symbols' 5m bars are
 * collected, so no other symbol can start emitting intraday alerts before
 * its thresholds are reviewed. SH513310 feeds volume_spike; HTGD (亨通光电
 * 600487) feeds the ma_cross reclaim watch; SZ159915 (创业板 ETF 易方达)
 * feeds the 15m retracement turning-point watch. SH000300 / SH000688 / SZ399006
 * are the CSI 300, STAR 50 and ChiNext index volume_spike watches (Sina 5m
 * constituent volume, verified 2026-11-18; not ETF proxies).
 */
export const INTRADAY_WHITELIST = [
  "SH513310",
  "HTGD",
  "SZ159915",
  "SH000300",
  "SH000688",
  "SZ399006",
] as const;

export interface SinaIntradaySymbolRecord {
  symbol: string;
  thsCode: string | null;
}

export interface SinaIntradayCollectorStore {
  listSymbols(): Promise<SinaIntradaySymbolRecord[]>;
  upsertCandles(symbol: string, source: Source, interval: "5m" | "15m", candles: readonly Candle[]): Promise<number>;
  recordSourceSuccess(source: Source): Promise<void>;
  recordSourceFailure(source: Source, error: string): Promise<void>;
  beginRun(holder: string, leaseSeconds: number): Promise<boolean>;
  finishRun(holder: string, outcome: string, backoffSeconds: number, summary: Record<string, unknown>): Promise<void>;
}

export interface SinaIntradayCollectorDeps {
  cronSecret: string | undefined;
  store: SinaIntradayCollectorStore;
  client: SinaIntradayData;
  now?: () => number;
  newHolder?: () => string;
  log?: (message: string) => void;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Symbols without a ths_code are skipped silently: most of symbol_map is
 * non-A-share (OKX perps, crypto, US stocks) and simply has no Sina
 * intraday bar. A ths_code that does not fit the SH/SZ/BJ pattern is logged
 * and skipped, so one bad mapping does not stop the other symbols.
 * Symbols outside the trial whitelist are skipped with a single summary
 * line, so a 40-row symbol_map does not spam one log line per symbol.
 */
export function toSinaIntradayTargets(
  records: readonly SinaIntradaySymbolRecord[],
  log: (message: string) => void,
): SinaIntradayTarget[] {
  const whitelist = new Set<string>(INTRADAY_WHITELIST);
  const targets: SinaIntradayTarget[] = [];
  let skippedOutsideWhitelist = 0;
  for (const record of records) {
    if (record.thsCode === null) continue;
    const sinaCode = toSinaCode(record.thsCode);
    if (sinaCode === null) {
      log(`ths_code for ${record.symbol} is not a mappable Sina code; skipping`);
      continue;
    }
    if (!whitelist.has(record.symbol)) {
      skippedOutsideWhitelist += 1;
      continue;
    }
    targets.push({ symbol: record.symbol, sinaCode });
  }
  if (skippedOutsideWhitelist > 0) {
    log(`skipped ${skippedOutsideWhitelist} symbols outside the intraday whitelist`);
  }
  return targets;
}

/**
 * Handles one pg_cron tick. Auth is checked before the database is touched.
 * A run takes a lease so overlapping ticks skip instead of double-polling,
 * and the lease is always released in `finally`, even when the run throws.
 * 5m candles are written under source 'sina', plus the 15m bars aggregated
 * from the complete confirmed 5m windows; no quotes are touched.
 * The lease and source_health rows are shared with sina-daily-collector
 * (both use source 'sina'): the two schedules do not overlap — intraday
 * ticks end at 15:00 Beijing, the daily run is at 15:35 — and the 600s
 * rate-limit backoff cannot bridge that gap.
 */
export function createSinaIntradayCollectorHandler(deps: SinaIntradayCollectorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newHolder = deps.newHolder ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((message: string) => console.info(`[sina-intraday-collector] ${message}`));

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
      const targets = toSinaIntradayTargets(await deps.store.listSymbols(), log);
      if (targets.length === 0) throw new Error("no whitelisted symbol has a mappable ths_code");

      const result = await runSinaIntradayCycle({
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
