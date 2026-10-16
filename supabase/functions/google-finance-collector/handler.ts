import { isAuthorized } from "./core/auth.ts";
import {
  buildGuidanceAlerts,
  eventDateOf,
  extractGuidance,
  type FinhubSession,
  GOOGLE_FINANCE_USER_AGENT,
  GOOGLE_SYMBOL_PATTERN,
  GoogleFinanceError,
  type GlanceCard,
  type GuidanceAlert,
  type GuidanceFindings,
  glanceRequest,
  inCallWindow,
  type PostRequest,
  parseFinhubTokens,
  parseGlanceCards,
  parseTranscriptSegments,
  quoteEarningsUrl,
  segmentHash,
  sessionNeedsRefresh,
  snapshotHash,
  transcriptRequest,
  type TranscriptSegment,
} from "./core/google-finance.ts";

export const SOURCE = "google-finance-earnings";
/** Edge Functions stop at 150 s. The lease expires at that point, so a hung run cannot block the next tick. */
export const LEASE_SECONDS = 150;
/** No new target starts after this budget. A target already in flight finishes within its own request timeouts. */
export const RUN_BUDGET_MS = 60_000;
export const MAX_TARGETS_PER_RUN = 3;
/** Google answers 429 or 403 for a blocked address and does not say when the block ends. */
export const BLOCKED_BACKOFF_SECONDS = 900;
const MAX_ERROR_LENGTH = 300;
const MAX_SNIPPET = 120;

export interface EarningsWatchRow {
  googleSymbol: string;
  symbol: string;
  isPrimary: boolean;
  enabled: boolean;
  callTimeMs: number | null;
  preMinutes: number;
  postMinutes: number;
  okxInstId: string | null;
  session: FinhubSession;
  sessionRefreshedAtMs: number | null;
}

export interface SnapshotWrite {
  payloadHash: string;
  cards: GlanceCard[];
  findings: GuidanceFindings;
  fetchedAtMs: number;
}

export interface SegmentWrite extends TranscriptSegment {
  hash: string;
}

export interface RecordBatch {
  snapshot: SnapshotWrite | null;
  segments: SegmentWrite[];
  alerts: GuidanceAlert[];
}

export interface RecordCounts {
  snapshots: number;
  segments: number;
  alerts: number;
}

export interface EarningsStore {
  listWatch(): Promise<EarningsWatchRow[]>;
  saveSession(googleSymbol: string, session: FinhubSession, refreshedAtMs: number): Promise<void>;
  record(googleSymbol: string, symbol: string, batch: RecordBatch): Promise<RecordCounts>;
  beginRun(holder: string, leaseSeconds: number): Promise<boolean>;
  finishRun(holder: string, outcome: string, backoffSeconds: number, summary: Record<string, unknown>): Promise<void>;
  recordSuccess(): Promise<void>;
  recordFailure(error: string): Promise<void>;
}

export interface GoogleFinanceCollectorDeps {
  cronSecret: string | undefined;
  store: EarningsStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  newHolder?: () => string;
  log?: (message: string) => void;
}

export interface CollectRequest {
  symbol: string | null;
  exchangeSymbol: string | null;
  exchange: string | null;
  dryRun: boolean;
}

export type TargetStatus = "ok" | "empty" | "partial" | "failed" | "blocked";

export interface TargetSummary {
  googleSymbol: string;
  symbol: string;
  okxInstId: string | null;
  status: TargetStatus;
  glanceCards: number;
  transcriptSegments: number;
  findings: GuidanceFindings;
  inCallWindow: boolean;
  alerts: number;
  recorded: RecordCounts | null;
  errors: string[];
  cards?: Array<{ title: string | null; text: string; offsetSec: number | null }>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function isBlocked(error: unknown): error is GoogleFinanceError {
  return error instanceof GoogleFinanceError && error.kind === "blocked";
}

/**
 * Accepts `{}` (scheduled tick), `{symbol}` (Hive symbol, resolves to the primary row) or `{exchangeSymbol, exchange}`
 * (Google's own pair, for example TSM + NYSE), plus an optional `dryRun`. A dry run fetches and parses but writes
 * nothing and takes no lease, so it is safe to run as a smoke test.
 */
export function parseCollectRequest(text: string): CollectRequest {
  const trimmed = text.trim();
  const raw: unknown = trimmed === "" ? {} : JSON.parse(trimmed);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("body must be a JSON object");
  const record = raw as Record<string, unknown>;

  const readString = (key: string): string | null => {
    const value = record[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
  };
  const symbol = readString("symbol");
  const exchangeSymbol = readString("exchangeSymbol");
  const exchange = readString("exchange");
  if (record.dryRun !== undefined && typeof record.dryRun !== "boolean") throw new Error("dryRun must be a boolean");

  if (symbol !== null && (exchangeSymbol !== null || exchange !== null)) {
    throw new Error("send either symbol or exchangeSymbol with exchange, not both");
  }
  if ((exchangeSymbol === null) !== (exchange === null)) throw new Error("exchangeSymbol and exchange must be sent together");
  if (symbol !== null && !/^[A-Z0-9]{1,20}$/.test(symbol)) throw new Error("symbol must match ^[A-Z0-9]{1,20}$");

  return { symbol, exchangeSymbol, exchange, dryRun: record.dryRun === true };
}

/** An explicit request targets one mapped row whatever its enabled flag or window. Only a tick is gated on both. */
export function selectTargets(
  rows: readonly EarningsWatchRow[],
  request: CollectRequest,
  nowMs: number,
): { targets: EarningsWatchRow[]; error?: string } {
  if (request.symbol !== null) {
    const match = rows
      .filter((row) => row.symbol === request.symbol)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
    return match ? { targets: [match] } : { targets: [], error: `${request.symbol} has no earnings_watch row` };
  }
  if (request.exchangeSymbol !== null && request.exchange !== null) {
    const googleSymbol = `${request.exchangeSymbol}:${request.exchange}`;
    if (!GOOGLE_SYMBOL_PATTERN.test(googleSymbol)) {
      return { targets: [], error: "exchangeSymbol and exchange do not form a valid Google Finance symbol" };
    }
    const match = rows.find((row) => row.googleSymbol === googleSymbol);
    return match ? { targets: [match] } : { targets: [], error: `${googleSymbol} has no earnings_watch row` };
  }
  return {
    targets: rows.filter((row) => row.enabled && inCallWindow(row.callTimeMs, nowMs, row.preMinutes, row.postMinutes)),
  };
}

async function fetchText(deps: GoogleFinanceCollectorDeps, label: string, url: string, init: RequestInit): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (response.status === 429 || response.status === 403) {
    throw new GoogleFinanceError(`${label} HTTP ${response.status}`, "blocked", response.status);
  }
  if (!response.ok) {
    throw new GoogleFinanceError(`${label} HTTP ${response.status}: ${text.slice(0, MAX_SNIPPET)}`, "http", response.status);
  }
  return text;
}

function getPage(deps: GoogleFinanceCollectorDeps, googleSymbol: string): Promise<string> {
  return fetchText(deps, "quote page", quoteEarningsUrl(googleSymbol), {
    method: "GET",
    headers: { "user-agent": GOOGLE_FINANCE_USER_AGENT, accept: "text/html,*/*" },
  });
}

function postRpc(deps: GoogleFinanceCollectorDeps, label: string, req: PostRequest): Promise<string> {
  return fetchText(deps, label, req.url, { method: "POST", headers: req.headers, body: req.body });
}

async function collectTarget(
  target: EarningsWatchRow,
  deps: GoogleFinanceCollectorDeps,
  persist: boolean,
  nowMs: number,
  dryRun: boolean,
): Promise<TargetSummary> {
  const log = deps.log ?? (() => {});
  const errors: string[] = [];
  let session = target.session;

  if (sessionNeedsRefresh(target.sessionRefreshedAtMs, nowMs)) {
    try {
      const tokens = parseFinhubTokens(await getPage(deps, target.googleSymbol));
      if (!tokens.bl && tokens.consent) {
        throw new GoogleFinanceError("consent interstitial instead of the quote page", "blocked");
      }
      session = { bl: tokens.bl ?? session.bl, sid: tokens.sid ?? session.sid };
      if (persist) await deps.store.saveSession(target.googleSymbol, session, nowMs);
    } catch (error) {
      if (isBlocked(error)) throw error;
      log(`session refresh failed for ${target.googleSymbol}, reusing the stored token: ${describeError(error)}`);
    }
  }

  let cards: GlanceCard[] = [];
  try {
    cards = parseGlanceCards(await postRpc(deps, "Xs5i3b", glanceRequest(target.googleSymbol, session, 1)));
  } catch (error) {
    if (isBlocked(error)) throw error;
    errors.push(`glance: ${describeError(error)}`);
  }

  let segments: TranscriptSegment[] = [];
  try {
    segments = parseTranscriptSegments(
      await postRpc(deps, "GetEarningsTranscript", transcriptRequest(target.googleSymbol, session, 2)),
    );
  } catch (error) {
    if (isBlocked(error)) throw error;
    errors.push(`transcript: ${describeError(error)}`);
  }

  if (cards.length === 0 && segments.length === 0 && errors.length > 0) {
    throw new GoogleFinanceError(errors.join("; "), "http");
  }

  const cardTexts = cards.map((card) => card.text);
  const findings = extractGuidance([...cardTexts, segments.map((segment) => segment.text).join(" ")]);
  const inWindow = inCallWindow(target.callTimeMs, nowMs, target.preMinutes, target.postMinutes);
  const alerts = inWindow
    ? buildGuidanceAlerts({
        symbol: target.symbol,
        googleSymbol: target.googleSymbol,
        eventDate: eventDateOf(target.callTimeMs),
        fetchedAt: new Date(nowMs).toISOString(),
        findings,
      })
    : [];

  let recorded: RecordCounts | null = null;
  if (persist && (cards.length > 0 || segments.length > 0)) {
    recorded = await deps.store.record(target.googleSymbol, target.symbol, {
      snapshot:
        cards.length > 0
          ? { payloadHash: snapshotHash(cardTexts, findings), cards, findings, fetchedAtMs: nowMs }
          : null,
      segments: segments.map((segment) => ({ ...segment, hash: segmentHash(target.symbol, segment) })),
      alerts,
    });
  }

  const hasData = cards.length > 0 || segments.length > 0;
  const status: TargetStatus = hasData ? (errors.length > 0 ? "partial" : "ok") : "empty";
  return {
    googleSymbol: target.googleSymbol,
    symbol: target.symbol,
    okxInstId: target.okxInstId,
    status,
    glanceCards: cards.length,
    transcriptSegments: segments.length,
    findings,
    inCallWindow: inWindow,
    alerts: alerts.length,
    recorded,
    errors,
    ...(dryRun
      ? { cards: cards.map((card) => ({ title: card.title, text: card.text, offsetSec: card.offsetSec })) }
      : {}),
  };
}

function failedSummary(target: EarningsWatchRow, status: TargetStatus, error: string): TargetSummary {
  return {
    googleSymbol: target.googleSymbol,
    symbol: target.symbol,
    okxInstId: target.okxInstId,
    status,
    glanceCards: 0,
    transcriptSegments: 0,
    findings: {},
    inCallWindow: false,
    alerts: 0,
    recorded: null,
    errors: [error],
  };
}

/**
 * Handles one invocation. The scheduled path runs only for enabled rows inside their call window and returns `idle`
 * without touching Google otherwise. Blocked responses stop the run and back off for 15 minutes. Other failures are
 * recorded per target, and the run continues with the next target.
 */
export function createGoogleFinanceCollectorHandler(deps: GoogleFinanceCollectorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newHolder = deps.newHolder ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((message: string) => console.info(`[google-finance-collector] ${message}`));

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    let input: CollectRequest;
    try {
      input = parseCollectRequest(await request.text());
    } catch (error) {
      return json(400, { error: describeError(error) });
    }

    const started = now();
    let rows: EarningsWatchRow[];
    try {
      rows = await deps.store.listWatch();
    } catch (error) {
      log(`could not read earnings_watch: ${describeError(error)}`);
      return json(500, { status: "error", error: "could not read earnings_watch" });
    }

    const selection = selectTargets(rows, input, started);
    if (selection.error) return json(404, { status: "error", error: selection.error });
    if (selection.targets.length === 0) {
      return json(200, { status: "idle", reason: "no enabled earnings_watch row is inside its call window" });
    }

    const persist = !input.dryRun;
    const holder = newHolder();
    if (persist) {
      try {
        if (!(await deps.store.beginRun(holder, LEASE_SECONDS))) {
          return json(200, { status: "skipped", reason: "a run holds the lease or blocked backoff is active" });
        }
      } catch (error) {
        log(`could not start run: ${describeError(error)}`);
        return json(500, { status: "error", error: "could not start run" });
      }
    }

    const batch = selection.targets.slice(0, MAX_TARGETS_PER_RUN);
    let skipped = selection.targets.length - batch.length;
    const summaries: TargetSummary[] = [];
    let blockedBy: string | null = null;
    let outcome = "error";
    let backoffSeconds = 0;
    let response: Response;

    try {
      for (const target of batch) {
        if (now() - started > RUN_BUDGET_MS) {
          skipped += 1;
          continue;
        }
        try {
          summaries.push(await collectTarget(target, deps, persist, now(), input.dryRun));
        } catch (error) {
          if (isBlocked(error)) {
            blockedBy = `${target.googleSymbol}: ${describeError(error)}`;
            summaries.push(failedSummary(target, "blocked", describeError(error)));
            break;
          }
          summaries.push(failedSummary(target, "failed", describeError(error)));
        }
      }

      const anyData = summaries.some((s) => s.status === "ok" || s.status === "partial");
      const errors = summaries.flatMap((s) => s.errors);
      if (blockedBy !== null) {
        outcome = "blocked";
        backoffSeconds = BLOCKED_BACKOFF_SECONDS;
      } else if (errors.length > 0) {
        outcome = anyData ? "degraded" : "error";
      } else if (summaries.every((s) => s.status === "empty")) {
        outcome = "empty";
      } else {
        outcome = "ok";
      }

      if (persist) {
        try {
          if (anyData) await deps.store.recordSuccess();
          else if (errors.length > 0) await deps.store.recordFailure(errors.join("; ").slice(0, MAX_ERROR_LENGTH));
        } catch (error) {
          log(`could not update source health: ${describeError(error)}`);
        }
      }

      const durationMs = now() - started;
      log(
        `${outcome} targets=${summaries.length} skipped=${skipped} alerts=${summaries.reduce((n, s) => n + s.alerts, 0)} ms=${durationMs}`,
      );
      response = json(200, { status: outcome, skipped, results: summaries, durationMs });
    } catch (error) {
      outcome = "error";
      log(`run error: ${describeError(error)}`);
      response = json(500, { status: "error", error: describeError(error) });
    } finally {
      if (persist) {
        const summary = {
          targets: batch.length,
          skipped,
          results: summaries.map((s) => ({ googleSymbol: s.googleSymbol, status: s.status, errors: s.errors })),
          durationMs: now() - started,
        };
        await deps.store.finishRun(holder, outcome, backoffSeconds, summary).catch((error: unknown) => {
          log(`could not release lease: ${describeError(error)}`);
        });
      }
    }
    return response;
  };
}
