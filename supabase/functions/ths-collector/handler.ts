import { isAuthorized } from "./core/auth.ts";
import { beijingClock, inSession, planTick } from "./core/ths-plan.ts";
import { runThsCycle, type ThsCycleStore, type ThsTarget } from "./core/ths-cycle.ts";
import type { ThsMarketData } from "./core/ths.ts";

/** Ticks are two minutes apart, so a lease shorter than that stops a hung run from blocking the next tick. */
export const LEASE_SECONDS = 90;
/** No new task starts after this budget. pg_net gives up on the HTTP call after 30 seconds. */
export const CYCLE_BUDGET_MS = 25_000;
export const CONCURRENCY = 4;
export const RATE_LIMIT_BACKOFF_SECONDS = 300;

export interface ThsCollectorStore extends ThsCycleStore {
  isSourceEnabled(): Promise<boolean>;
  listTargets(): Promise<ThsTarget[]>;
  beginRun(holder: string, leaseSeconds: number): Promise<boolean>;
  finishRun(holder: string, outcome: string, backoffSeconds: number, summary: Record<string, unknown>): Promise<void>;
}

export interface ThsCollectorDeps {
  cronSecret: string | undefined;
  apiKey: string | undefined;
  store: ThsCollectorStore;
  client: ThsMarketData;
  now?: () => number;
  newHolder?: () => string;
  log?: (message: string) => void;
}

type CalendarStatus = "trading" | "closed" | "unknown";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function previousWeekday(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  do {
    day.setUTCDate(day.getUTCDate() - 1);
  } while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/**
 * The calendar lists trading days from one year ago through today. A date that is missing while the list reaches the
 * previous weekday is a closed day. A list that stops earlier is treated as unknown, so a stale calendar cannot stop
 * polling on a trading day. Unknown means the tick polls as normal.
 */
export function calendarStatusFor(date: string, days: ReadonlySet<string>): CalendarStatus {
  if (days.has(date)) return "trading";
  let latest = "";
  for (const day of days) if (day > latest) latest = day;
  return latest >= previousWeekday(date) ? "closed" : "unknown";
}

/**
 * Handles one pg_net tick. Gates run in order and each is cheap: auth, the A-share session window, the source
 * switch, then the trading calendar. Only then does the tick take the lease and poll. A non-trading day records a
 * success heartbeat, so the session-gated stale check does not fire on holidays. It does not mark the source failed.
 */
export function createThsCollectorHandler(deps: ThsCollectorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newHolder = deps.newHolder ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((message: string) => console.info(`[ths-collector] ${message}`));
  let calendarCache: { date: string; days: Set<string> } | null = null;

  const calendarStatus = async (date: string): Promise<CalendarStatus> => {
    if (calendarCache !== null && calendarCache.date === date) {
      return calendarStatusFor(date, calendarCache.days);
    }
    try {
      const days = await deps.client.tradingDays();
      calendarCache = { date, days };
      return calendarStatusFor(date, days);
    } catch (error) {
      log(`trading calendar unavailable, polling as usual: ${(error as Error).message}`);
      return "unknown";
    }
  };

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
    if (!deps.apiKey) {
      return json(500, { error: "HITHINK_FINANCE_API_KEY is not configured" });
    }

    const started = now();
    const clock = beijingClock(started);
    if (!inSession(clock)) {
      return json(200, { status: "skipped", reason: "outside the A-share session window" });
    }

    try {
      if (!(await deps.store.isSourceEnabled())) {
        return json(200, { status: "skipped", reason: "source ths is disabled" });
      }
    } catch (error) {
      log(`could not read source_health: ${(error as Error).message}`);
      return json(500, { status: "error", error: "could not read source_health" });
    }

    const calendar = await calendarStatus(clock.date);
    if (calendar === "closed") {
      await deps.store.recordSourceSuccess("ths").catch((error: unknown) => {
        log(`could not record calendar heartbeat: ${(error as Error).message}`);
      });
      return json(200, { status: "non_trading_day", date: clock.date });
    }

    const targets = await deps.store.listTargets();
    const tasks = planTick(clock, { hasAuctionWatchlist: targets.some((target) => target.auction) });

    const holder = newHolder();
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
      const result = await runThsCycle({
        client: deps.client,
        store: deps.store,
        tasks,
        targets,
        date: clock.date,
        now,
        deadlineMs: started + CYCLE_BUDGET_MS,
        concurrency: CONCURRENCY,
        log,
      });
      outcome = result.outcome;
      if (result.rateLimited) backoffSeconds = RATE_LIMIT_BACKOFF_SECONDS;
      const persisted = result.persisted;
      summary = {
        date: clock.date,
        calendar,
        persisted,
        tasks: result.tasks.map((t) => ({ task: t.task, status: t.status, persisted: t.persisted, error: t.error })),
        durationMs: now() - started,
      };
      log(`cycle ${outcome} persisted=${persisted} tasks=${tasks.length} ms=${now() - started}`);
      return json(200, { status: outcome, ...summary });
    } catch (error) {
      const message = (error as Error).message;
      summary = { error: message.slice(0, 300), durationMs: now() - started };
      log(`cycle error: ${message}`);
      return json(500, { status: "error", error: message.slice(0, 300) });
    } finally {
      await deps.store.finishRun(holder, outcome, backoffSeconds, summary).catch((error: unknown) => {
        log(`could not release lease: ${(error as Error).message}`);
      });
    }
  };
}
