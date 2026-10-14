import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_EVENT_TYPES = ["news", "alert"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const SIGNATURE_HEADER = "x-hive-signature";
export const TIMESTAMP_HEADER = "x-hive-timestamp";
export const EVENT_HEADER = "x-hive-event";
export const DELIVERY_HEADER = "x-hive-delivery-id";

export const MAX_DELIVERY_ATTEMPTS = 6;
export const MAX_BACKOFF_SECONDS = 3600;
const BASE_BACKOFF_SECONDS = 30;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 256;
const MAX_FILTER_ITEMS = 50;
const AUTH_TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/;

/** Delay before the next attempt, after `attempt` failed attempts (1-based): 30s, 60s, 120s, ... capped at 1h. */
export function computeBackoffSeconds(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt, 32) - 1);
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** exponent);
}

/** HMAC-SHA256 over `${timestamp}.${body}`, so a captured signature cannot be replayed with a new timestamp. */
export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `sha256=${digest}`;
}

/** Receivers should call this with the raw request body. Rejects stale timestamps to limit replay. */
export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signWebhookBody(secret, timestamp, body));
  const presented = Buffer.from(signature);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

export interface SubscriptionFilters {
  sources?: string[];
  keywords?: string[];
  severities?: AlertSeverity[];
  alert_kinds?: string[];
  symbols?: string[];
}

const FILTER_KEYS = ["sources", "keywords", "severities", "alert_kinds", "symbols"] as const;

export class SubscriptionInputError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "SubscriptionInputError";
    this.problems = problems;
  }
}

/** Absent fields stay undefined so a PATCH only touches what the caller sent. */
export interface SubscriptionInput {
  agent_name?: string;
  url?: string;
  secret: string | null;
  /** Undefined keeps the stored token, null clears it, a string replaces it. */
  auth_token?: string | null;
  event_types?: WebhookEventType[];
  filters?: SubscriptionFilters;
  enabled?: boolean;
  rotate_secret: boolean;
}

function stringList(raw: unknown, field: string, problems: string[], maxLength: number, lowercase = false): string[] | undefined {
  if (!Array.isArray(raw)) {
    problems.push(`${field} must be an array of strings`);
    return undefined;
  }
  if (raw.length > MAX_FILTER_ITEMS) problems.push(`${field} allows at most ${MAX_FILTER_ITEMS} entries`);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "" || entry.trim().length > maxLength) {
      problems.push(`${field} entries must be non-empty strings up to ${maxLength} characters`);
      return undefined;
    }
    const value = lowercase ? entry.trim().toLowerCase() : entry.trim();
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** Validates the `filters` object. Unknown keys are rejected so typos do not silently widen a subscription. */
export function parseSubscriptionFilters(raw: unknown): { filters: SubscriptionFilters; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { filters: {}, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) return { filters: {}, problems: ["filters must be an object"] };

  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) problems.push(`unknown filter "${key}"`);
  }

  const filters: SubscriptionFilters = {};
  if (input.sources !== undefined) {
    const values = stringList(input.sources, "sources", problems, 32, true);
    if (values) {
      if (values.some((v) => !/^[a-z0-9_]+$/.test(v))) problems.push("sources must match [a-z0-9_]+");
      filters.sources = values;
    }
  }
  if (input.keywords !== undefined) {
    const values = stringList(input.keywords, "keywords", problems, 64);
    if (values) filters.keywords = values;
  }
  if (input.severities !== undefined) {
    const values = stringList(input.severities, "severities", problems, 16, true);
    if (values) {
      const bad = values.filter((v) => !(ALERT_SEVERITIES as readonly string[]).includes(v));
      if (bad.length > 0) problems.push(`severities must be one of ${ALERT_SEVERITIES.join(", ")}`);
      filters.severities = values as AlertSeverity[];
    }
  }
  if (input.alert_kinds !== undefined) {
    const values = stringList(input.alert_kinds, "alert_kinds", problems, 64, true);
    if (values) filters.alert_kinds = values;
  }
  if (input.symbols !== undefined) {
    const values = stringList(input.symbols, "symbols", problems, 20, true);
    if (values) {
      if (values.some((v) => !/^[a-z0-9]+$/.test(v))) problems.push("symbols must be alphanumeric");
      filters.symbols = values.map((v) => v.toUpperCase());
    }
  }
  return { filters, problems };
}

/** Validates a subscription create or update body. Throws SubscriptionInputError listing every problem. */
export function parseSubscriptionInput(raw: unknown, options: { requireAll: boolean }): SubscriptionInput {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SubscriptionInputError(["body must be a JSON object"]);
  }
  const body = raw as Record<string, unknown>;

  const agentName = body.agent_name;
  if (agentName !== undefined || options.requireAll) {
    if (typeof agentName !== "string" || !/^[a-z0-9_-]{1,64}$/.test(agentName)) {
      problems.push("agent_name must match [a-z0-9_-]{1,64}");
    }
  }

  const url = body.url;
  if (url !== undefined || options.requireAll) {
    if (typeof url !== "string" || url.length > 2048) {
      problems.push("url must be a string up to 2048 characters");
    } else {
      try {
        if (new URL(url).protocol !== "https:") problems.push("url must use https");
      } catch {
        problems.push("url must be a valid https URL");
      }
    }
  }

  let secret: string | null = null;
  if (body.secret !== undefined && body.secret !== null) {
    if (typeof body.secret !== "string" || body.secret.length < MIN_SECRET_LENGTH || body.secret.length > MAX_SECRET_LENGTH) {
      problems.push(`secret must be ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters`);
    } else {
      secret = body.secret;
    }
  }

  let eventTypes: WebhookEventType[] | undefined;
  if (body.event_types !== undefined) {
    if (!Array.isArray(body.event_types) || body.event_types.length === 0) {
      problems.push("event_types must be a non-empty array");
    } else if (body.event_types.some((t) => !(WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(t))) {
      problems.push(`event_types must be a subset of ${WEBHOOK_EVENT_TYPES.join(", ")}`);
    } else {
      eventTypes = [...new Set(body.event_types as WebhookEventType[])];
    }
  }

  const filterResult = body.filters === undefined ? undefined : parseSubscriptionFilters(body.filters);
  if (filterResult) problems.push(...filterResult.problems);

  let authToken: string | null | undefined;
  if (body.auth_token === null) {
    authToken = null;
  } else if (body.auth_token !== undefined) {
    if (typeof body.auth_token !== "string" || !AUTH_TOKEN_PATTERN.test(body.auth_token)) {
      problems.push("auth_token must be 16-512 visible ASCII characters without spaces");
    } else {
      authToken = body.auth_token;
    }
  }

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") problems.push("enabled must be a boolean");
  if (body.rotate_secret !== undefined && typeof body.rotate_secret !== "boolean") problems.push("rotate_secret must be a boolean");

  if (problems.length > 0) throw new SubscriptionInputError(problems);

  return {
    agent_name: typeof agentName === "string" ? agentName : undefined,
    url: typeof url === "string" ? url : undefined,
    secret,
    auth_token: authToken,
    event_types: eventTypes,
    filters: filterResult?.filters,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    rotate_secret: body.rotate_secret === true,
  };
}
