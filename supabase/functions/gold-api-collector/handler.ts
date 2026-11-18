import { isAuthorized } from "./core/auth.ts";
import {
  GOLD_API_BASE_URL,
  GOLD_API_HIVE_SOURCE,
  GOLD_API_HIVE_SYMBOL,
  GOLD_API_SPOT_PATH,
  parseGoldApiSpotUsd,
  type GoldApiSpotQuote,
} from "./core/gold-api.ts";

export const LEASE_SECONDS = 60;
export const FETCH_TIMEOUT_MS = 10_000;
export const SOURCE = GOLD_API_HIVE_SOURCE;
export const SYMBOL = GOLD_API_HIVE_SYMBOL;

export interface GoldApiCollectorStore {
  beginRun(holder: string, leaseSeconds: number): Promise<boolean>;
  finishRun(holder: string, outcome: string, backoffSeconds: number, summary: Record<string, unknown>): Promise<void>;
  upsertQuote(symbol: string, source: string, quote: { price: number; ts: number }): Promise<void>;
  recordSourceSuccess(source: string): Promise<void>;
  recordSourceFailure(source: string, error: string): Promise<void>;
}

export interface GoldApiClient {
  fetchSpotUsd(): Promise<unknown>;
}

export interface GoldApiCollectorDeps {
  cronSecret: string | undefined;
  store: GoldApiCollectorStore;
  client: GoldApiClient;
  now?: () => number;
  newHolder?: () => string;
  log?: (message: string) => void;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function officialSpotUrl(baseUrl = GOLD_API_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}${GOLD_API_SPOT_PATH}`;
}

export function createHttpGoldApiClient(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}): GoldApiClient {
  const baseUrl = options.baseUrl ?? GOLD_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const userAgent = options.userAgent ?? "Hive gold-api-collector";
  return {
    async fetchSpotUsd(): Promise<unknown> {
      const response = await fetchImpl(officialSpotUrl(baseUrl), {
        method: "GET",
        headers: { accept: "application/json", "user-agent": userAgent },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`gold-api HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) : null;
    },
  };
}

/**
 * One pg_cron tick: fetch the official XAU USD spot snapshot, persist it under
 * source=gold-api symbol=XAUUSD, and never write fabricated 1m candles.
 */
export function createGoldApiCollectorHandler(deps: GoldApiCollectorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newHolder = deps.newHolder ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((message: string) => console.info(`[gold-api-collector] ${message}`));

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
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
      const message = error instanceof Error ? error.message : String(error);
      log(`begin failed: ${message}`);
      return json(500, { error: message.slice(0, 300) });
    }

    let outcome = "ok";
    let quote: GoldApiSpotQuote | null = null;
    let errorMessage = "";
    try {
      const payload = await deps.client.fetchSpotUsd();
      quote = parseGoldApiSpotUsd(payload, { nowMs: now() });
      await deps.store.upsertQuote(SYMBOL, SOURCE, { price: quote.price, ts: quote.ts });
      await deps.store.recordSourceSuccess(SOURCE);
      log(`spot ${SYMBOL} price=${quote.price} ts=${new Date(quote.ts).toISOString()}`);
    } catch (error) {
      outcome = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
      log(`poll failed: ${errorMessage}`);
      try {
        await deps.store.recordSourceFailure(SOURCE, errorMessage);
      } catch (healthError) {
        log(`source_health write failed: ${healthError instanceof Error ? healthError.message : String(healthError)}`);
      }
    } finally {
      try {
        await deps.store.finishRun(holder, outcome, 0, {
          symbol: SYMBOL,
          source: SOURCE,
          price: quote?.price ?? null,
          quote_ts: quote ? new Date(quote.ts).toISOString() : null,
          error: errorMessage.slice(0, 300) || null,
          ms: now() - started,
        });
      } catch (finishError) {
        log(`finish failed: ${finishError instanceof Error ? finishError.message : String(finishError)}`);
      }
    }

    if (outcome !== "ok") return json(500, { status: "error", error: errorMessage.slice(0, 300) });
    return json(200, {
      status: "ok",
      source: SOURCE,
      symbol: SYMBOL,
      price: quote!.price,
      quote_ts: new Date(quote!.ts).toISOString(),
      durationMs: now() - started,
    });
  };
}
