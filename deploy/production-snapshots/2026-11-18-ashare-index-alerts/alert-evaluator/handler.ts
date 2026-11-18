import { isAuthorized } from "./core/auth.ts";
import {
  alertDedupKey,
  evaluateRule,
  isCooldownActive,
  isFreshBar,
  parseRuleParams,
  type RuleEvaluation,
  type RuleParams,
  ruleBarsNeeded,
  ruleInterval,
} from "./core/alerts.ts";
import { evaluateSnapshotCross, isFreshQuote } from "./core/snapshot-cross.ts";
import type { Candle, Interval } from "./core/types.ts";

export interface AlertRuleRow {
  id: string;
  name: string;
  symbol: string;
  source: string;
  kind: string;
  params: unknown;
  cooldownSeconds: number;
  /** Epoch milliseconds of the last inserted alert for this rule, or null. */
  lastTriggeredAtMs: number | null;
  lastQuotePrice: number | null;
  lastQuoteTsMs: number | null;
}

export interface QuoteRow {
  price: number;
  ts: number;
}

export interface CandleRequest {
  symbol: string;
  source: string;
  interval: Interval;
  limit: number;
}

export interface AlertInsert {
  dedup_key: string;
  rule_id: string;
  symbol: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  payload: Record<string, unknown>;
  /** When true, hive_alert_evaluator_record disables the rule after a successful insert. */
  disable_rule?: boolean;
}

export interface RecordResult {
  inserted: number;
  duplicates: number;
}

export interface EvaluatorStore {
  listEnabledRules(): Promise<AlertRuleRow[]>;
  /** Most recent `limit` confirmed bars, ascending by ts. */
  confirmedCandles(request: CandleRequest): Promise<Candle[]>;
  latestQuote(symbol: string, source: string): Promise<QuoteRow | null>;
  observeQuote(ruleId: string, price: number, ts: number): Promise<void>;
  recordAlerts(alerts: AlertInsert[]): Promise<RecordResult>;
}

export interface EvaluatorDeps {
  cronSecret: string | undefined;
  store: EvaluatorStore;
  now?: () => number;
  log?: (message: string) => void;
}

interface EvaluatedRule {
  rule: AlertRuleRow;
  params: RuleParams;
}

export interface EvaluationSummary {
  status: "ok" | "partial";
  rules: number;
  invalid: number;
  fired: number;
  inserted: number;
  duplicates: number;
  skipped: { no_data: number; stale: number; not_fired: number; cooldown: number; candle_failed: number };
  failures: string[];
  durationMs: number;
}

const MAX_ERROR_LENGTH = 300;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function seriesKey(symbol: string, source: string, interval: Interval): string {
  return `${symbol}|${source}|${interval}`;
}

/**
 * Groups rules by (symbol, source, interval) so each series is fetched once, with the largest window any rule
 * on it needs. Evaluators read only the tail of the array, so a longer window does not change their result.
 */
function groupRequests(rules: EvaluatedRule[]): Map<string, CandleRequest> {
  const requests = new Map<string, CandleRequest>();
  for (const { rule, params } of rules) {
    if (params.kind === "snapshot_cross") continue;
    const interval = ruleInterval(params);
    const key = seriesKey(rule.symbol, rule.source, interval);
    const limit = Math.max(ruleBarsNeeded(params), requests.get(key)?.limit ?? 0);
    requests.set(key, { symbol: rule.symbol, source: rule.source, interval, limit });
    // ma_cross reads its average off the same source's daily closes, so the
    // daily series is fetched alongside the intraday one, once per symbol.
    if (params.kind === "ma_cross") {
      const dailyKey = seriesKey(rule.symbol, rule.source, "1D");
      const dailyLimit = Math.max(params.period, requests.get(dailyKey)?.limit ?? 0);
      requests.set(dailyKey, { symbol: rule.symbol, source: rule.source, interval: "1D", limit: dailyLimit });
    }
  }
  return requests;
}

function buildAlert(rule: AlertRuleRow, params: RuleParams, evaluation: RuleEvaluation): AlertInsert {
  const isSnapshot = params.kind === "snapshot_cross";
  return {
    dedup_key: alertDedupKey(rule.id, evaluation.barTs),
    rule_id: rule.id,
    symbol: rule.symbol,
    kind: rule.kind,
    severity: "warning",
    disable_rule: isSnapshot && params.once,
    payload: {
      source: rule.source,
      symbol: rule.symbol,
      rule_id: rule.id,
      rule_name: rule.name,
      ...(isSnapshot
        ? {
            quote_type: "spot_snapshot",
            unit: "USD_per_troy_oz",
            quote_ts: new Date(evaluation.barTs).toISOString(),
            once: params.once,
          }
        : { interval: ruleInterval(params) }),
      bar_ts: new Date(evaluation.barTs).toISOString(),
      ...evaluation.details,
    },
  };
}

/**
 * Evaluates every enabled alert rule against the latest confirmed bars and writes matches to alerts. Delivery is
 * left to the alerts_fanout trigger and the webhook-dispatcher cron. Evaluation is idempotent per bar: the dedup
 * key is alertDedupKey(ruleId, barTs), so a rerun or overlapping run never double-fires.
 */
export function createAlertEvaluatorHandler(deps: EvaluatorDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.info(`[alert-evaluator] ${message}`));

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!deps.cronSecret) return json(500, { error: "EDGE_CRON_SECRET is not configured" });
    if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
      return json(401, { error: "unauthorized" });
    }

    const started = now();

    let rules: AlertRuleRow[];
    try {
      rules = await deps.store.listEnabledRules();
    } catch (error) {
      const message = `alert_rules read failed: ${describeError(error)}`;
      log(message);
      return json(500, { error: message });
    }

    const parsed: EvaluatedRule[] = [];
    let invalid = 0;
    for (const rule of rules) {
      try {
        parsed.push({ rule, params: parseRuleParams(rule.kind, rule.params) });
      } catch (error) {
        invalid += 1;
        log(`rule ${rule.id} skipped: ${describeError(error)}`);
      }
    }

    const failures: string[] = [];
    const series = new Map<string, Candle[]>();
    for (const [key, candleRequest] of groupRequests(parsed)) {
      try {
        series.set(key, await deps.store.confirmedCandles(candleRequest));
      } catch (error) {
        failures.push(`${key}: ${describeError(error)}`);
      }
    }

    const skipped = { no_data: 0, stale: 0, not_fired: 0, cooldown: 0, candle_failed: 0 };
    const alerts: AlertInsert[] = [];
    const nowMs = now();
    for (const { rule, params } of parsed) {
      if (params.kind === "snapshot_cross") {
        try {
          const quote = await deps.store.latestQuote(rule.symbol, rule.source);
          if (!quote) {
            skipped.no_data += 1;
            continue;
          }
          if (!isFreshQuote(quote.ts, params.maxQuoteAgeSeconds, nowMs)) {
            skipped.stale += 1;
            continue;
          }
          const previous =
            rule.lastQuoteTsMs === null || rule.lastQuotePrice === null || !Number.isFinite(rule.lastQuotePrice)
              ? null
              : { price: rule.lastQuotePrice, ts: rule.lastQuoteTsMs };
          if (previous !== null && !(quote.ts > previous.ts)) {
            skipped.not_fired += 1;
            continue;
          }
          const fired = evaluateSnapshotCross(params, previous, quote);
          if (!fired) {
            await deps.store.observeQuote(rule.id, quote.price, quote.ts);
            skipped.not_fired += 1;
            continue;
          }
          if (isCooldownActive(rule.lastTriggeredAtMs, rule.cooldownSeconds, nowMs)) {
            skipped.cooldown += 1;
            continue;
          }
          alerts.push(
            buildAlert(rule, params, {
              barTs: quote.ts,
              details: { last_price: quote.price, previous_price: previous!.price, level: params.level },
            }),
          );
        } catch (error) {
          skipped.candle_failed += 1;
          failures.push(`snapshot ${rule.symbol}|${rule.source}: ${describeError(error)}`);
        }
        continue;
      }
      const interval = ruleInterval(params);
      const bars = series.get(seriesKey(rule.symbol, rule.source, interval));
      if (!bars) {
        skipped.candle_failed += 1;
        continue;
      }
      const last = bars[bars.length - 1];
      if (!last) {
        skipped.no_data += 1;
        continue;
      }
      if (!isFreshBar(last.ts, interval, nowMs)) {
        skipped.stale += 1;
        continue;
      }
      // ma_cross needs its daily closes as well; a missing daily series is a
      // fetch failure, fewer than `period` closes is simply not enough data.
      // The freshness gate above still applies to the intraday bar only: daily
      // closes are completed days by construction, so they carry no freshness.
      let evaluation: RuleEvaluation | null;
      if (params.kind === "ma_cross") {
        const daily = series.get(seriesKey(rule.symbol, rule.source, "1D"));
        if (!daily) {
          skipped.candle_failed += 1;
          continue;
        }
        if (daily.length < params.period) {
          skipped.no_data += 1;
          continue;
        }
        evaluation = evaluateRule(params, bars, daily);
      } else {
        evaluation = evaluateRule(params, bars);
      }
      if (!evaluation) {
        skipped.not_fired += 1;
        continue;
      }
      if (isCooldownActive(rule.lastTriggeredAtMs, rule.cooldownSeconds, nowMs)) {
        skipped.cooldown += 1;
        continue;
      }
      alerts.push(buildAlert(rule, params, evaluation));
    }

    let recorded: RecordResult = { inserted: 0, duplicates: 0 };
    if (alerts.length > 0) {
      try {
        recorded = await deps.store.recordAlerts(alerts);
      } catch (error) {
        const message = `alerts write failed: ${describeError(error)}`;
        log(message);
        return json(500, { error: message });
      }
    }

    const summary: EvaluationSummary = {
      status: failures.length > 0 ? "partial" : "ok",
      rules: rules.length,
      invalid,
      fired: alerts.length,
      inserted: recorded.inserted,
      duplicates: recorded.duplicates,
      skipped,
      failures,
      durationMs: now() - started,
    };
    log(
      `rules=${summary.rules} fired=${summary.fired} inserted=${summary.inserted} duplicates=${summary.duplicates} ` +
        `skipped=${JSON.stringify(summary.skipped)} ms=${summary.durationMs}`,
    );
    return json(200, summary);
  };
}
