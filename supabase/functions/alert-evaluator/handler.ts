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
}

export interface RecordResult {
  inserted: number;
  duplicates: number;
}

export interface EvaluatorStore {
  listEnabledRules(): Promise<AlertRuleRow[]>;
  /** Most recent `limit` confirmed bars, ascending by ts. */
  confirmedCandles(request: CandleRequest): Promise<Candle[]>;
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
    const interval = ruleInterval(params);
    const key = seriesKey(rule.symbol, rule.source, interval);
    const limit = Math.max(ruleBarsNeeded(params), requests.get(key)?.limit ?? 0);
    requests.set(key, { symbol: rule.symbol, source: rule.source, interval, limit });
  }
  return requests;
}

function buildAlert(rule: AlertRuleRow, params: RuleParams, evaluation: RuleEvaluation): AlertInsert {
  return {
    dedup_key: alertDedupKey(rule.id, evaluation.barTs),
    rule_id: rule.id,
    symbol: rule.symbol,
    kind: rule.kind,
    severity: "warning",
    payload: {
      source: rule.source,
      symbol: rule.symbol,
      rule_id: rule.id,
      rule_name: rule.name,
      interval: ruleInterval(params),
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
      const evaluation = evaluateRule(params, bars);
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
