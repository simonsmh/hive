import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_BACKOFF_SECONDS,
  REPLAY_LAG_SECONDS,
  SubscriptionInputError,
  computeBackoffSeconds,
  deliveryFlags,
  parseSubscriptionFilters,
  parseSubscriptionInput,
  signWebhookBody,
  verifyWebhookSignature,
  withDeliveryFlags,
} from "./webhook.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("computeBackoffSeconds", () => {
  it("doubles from 30 seconds and caps at one hour", () => {
    expect([1, 2, 3, 4, 5, 6].map(computeBackoffSeconds)).toEqual([30, 60, 120, 240, 480, 960]);
    expect(computeBackoffSeconds(20)).toBe(MAX_BACKOFF_SECONDS);
    expect(computeBackoffSeconds(0)).toBe(30);
  });
});

describe("signWebhookBody", () => {
  it("is HMAC-SHA256 over `${timestamp}.${body}`, hex encoded and prefixed with sha256=", () => {
    const expected = createHmac("sha256", "Jefe").update("1700000000.what do ya want for nothing?", "utf8").digest("hex");
    expect(signWebhookBody("Jefe", 1700000000, "what do ya want for nothing?")).toBe(`sha256=${expected}`);
  });

  it("changes when the timestamp changes, so signatures cannot be replayed with a fresh timestamp", () => {
    expect(signWebhookBody(SECRET, 1, "{}")).not.toBe(signWebhookBody(SECRET, 2, "{}"));
  });
});

describe("verifyWebhookSignature", () => {
  const now = 1_700_000_000;
  const body = '{"type":"news"}';

  it("accepts a fresh, correctly signed body", () => {
    expect(verifyWebhookSignature(SECRET, now, body, signWebhookBody(SECRET, now, body), now + 10)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a stale timestamp and a malformed signature", () => {
    const sig = signWebhookBody(SECRET, now, body);
    expect(verifyWebhookSignature(SECRET, now, '{"type":"alert"}', sig, now)).toBe(false);
    expect(verifyWebhookSignature("another-secret-value-0123456789ab", now, body, sig, now)).toBe(false);
    expect(verifyWebhookSignature(SECRET, now, body, sig, now + 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, now, body, "sha256=short", now)).toBe(false);
  });
});

describe("parseSubscriptionFilters", () => {
  it("normalises sources and severities and upper-cases symbols", () => {
    const { filters, problems } = parseSubscriptionFilters({
      sources: [" JIN10 ", "jin10"],
      keywords: ["  美联储 "],
      severities: ["WARNING"],
      symbols: ["btc"],
    });
    expect(problems).toEqual([]);
    expect(filters).toEqual({ sources: ["jin10"], keywords: ["美联储"], severities: ["warning"], symbols: ["BTC"] });
  });

  it("rejects unknown keys and bad values instead of silently widening the subscription", () => {
    const { problems } = parseSubscriptionFilters({ keyword: ["x"], severities: ["urgent"], sources: ["bad-source!"] });
    expect(problems).toEqual(
      expect.arrayContaining([
        'unknown filter "keyword"',
        "severities must be one of info, warning, critical",
        "sources must match [a-z0-9_]+",
      ]),
    );
  });

  it("requires an object and arrays of non-empty strings", () => {
    expect(parseSubscriptionFilters([]).problems).toEqual(["filters must be an object"]);
    expect(parseSubscriptionFilters({ keywords: "fed" }).problems).toEqual(["keywords must be an array of strings"]);
    expect(parseSubscriptionFilters({ keywords: [""] }).problems[0]).toMatch(/non-empty strings/);
  });
});

describe("parseSubscriptionInput", () => {
  const valid = {
    agent_name: "trader-bot",
    url: "https://agent.example.com/hook",
    secret: SECRET,
    event_types: ["news"],
    filters: { keywords: ["fed"] },
  };

  it("accepts a complete create body and applies the default enabled flag only at the database", () => {
    expect(parseSubscriptionInput(valid, { requireAll: true })).toEqual({
      agent_name: "trader-bot",
      url: "https://agent.example.com/hook",
      secret: SECRET,
      event_types: ["news"],
      filters: { keywords: ["fed"] },
      enabled: undefined,
      rotate_secret: false,
    });
  });

  it("leaves absent fields undefined so a partial update does not reset them", () => {
    const patch = parseSubscriptionInput({ enabled: false }, { requireAll: false });
    expect(patch).toEqual({
      agent_name: undefined,
      url: undefined,
      secret: null,
      event_types: undefined,
      filters: undefined,
      enabled: false,
      rotate_secret: false,
    });
  });

  it("collects every problem in one error", () => {
    try {
      parseSubscriptionInput({ agent_name: "Bad Name", url: "http://insecure.example.com", secret: "short", event_types: ["sms"] }, { requireAll: true });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionInputError);
      const problems = (error as SubscriptionInputError).problems;
      expect(problems).toEqual(
        expect.arrayContaining([
          "agent_name must match [a-z0-9_-]{1,64}",
          "url must use https",
          "secret must be 32-256 characters",
          "event_types must be a subset of news, alert",
        ]),
      );
    }
  });

  it("distinguishes an absent bearer token (keep), null (clear) and a string (replace)", () => {
    expect(parseSubscriptionInput(valid, { requireAll: true }).auth_token).toBeUndefined();
    expect(parseSubscriptionInput({ auth_token: null }, { requireAll: false }).auth_token).toBeNull();
    expect(parseSubscriptionInput({ auth_token: "grok-key-0123456789ab" }, { requireAll: false }).auth_token).toBe("grok-key-0123456789ab");
  });

  it("rejects bearer tokens that are too short, contain spaces or non-ASCII, or are not strings", () => {
    for (const bad of ["short", "has space 0123456789abcdef", "密钥0123456789abcdef0123", 12345678]) {
      expect(() => parseSubscriptionInput({ auth_token: bad }, { requireAll: false })).toThrow(
        "auth_token must be 16-512 visible ASCII characters without spaces",
      );
    }
  });

  it("rejects non-object bodies", () => {
    expect(() => parseSubscriptionInput([], { requireAll: true })).toThrow(SubscriptionInputError);
    expect(() => parseSubscriptionInput(null, { requireAll: false })).toThrow(/JSON object/);
  });
});

describe("deliveryFlags", () => {
  const CREATED = Date.parse("2026-10-14T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const critical = (overrides: Partial<Parameters<typeof deliveryFlags>[0]> = {}) => ({
    priority: "critical" as const,
    eventTs: iso(CREATED),
    createdAt: iso(CREATED),
    staleAfterSeconds: 60,
    ...overrides,
  });

  it("is neither stale nor replay for a live send inside both windows", () => {
    expect(deliveryFlags(critical(), CREATED + 5_000)).toEqual({
      priority: "critical",
      event_ts: iso(CREATED),
      stale: false,
      replay: false,
    });
  });

  it("is stale when the event is older than its threshold, whatever the queue lag", () => {
    const flags = deliveryFlags(critical({ eventTs: iso(CREATED - 90_000), createdAt: iso(CREATED + 4_000) }), CREATED + 5_000);
    expect(flags.stale).toBe(true);
    expect(flags.replay).toBe(false);
  });

  it("is replay when the send lags its insert past the replay window, even if the event is still fresh", () => {
    const flags = deliveryFlags(critical({ staleAfterSeconds: 120 }), CREATED + (REPLAY_LAG_SECONDS + 10) * 1000);
    expect(flags.stale).toBe(false);
    expect(flags.replay).toBe(true);
  });

  it("uses the insert time for staleness when the event time is unknown, and treats unparseable times as stale", () => {
    expect(deliveryFlags(critical({ eventTs: null, staleAfterSeconds: 60 }), CREATED + 90_000).stale).toBe(true);
    expect(deliveryFlags(critical({ eventTs: null }), CREATED + 1_000).stale).toBe(false);
    expect(deliveryFlags(critical({ eventTs: "not a time" }), CREATED).stale).toBe(true);
  });

  it("never lets a delayed delivery through with both flags clear", () => {
    for (const lag of [0, 5, 29, 31, 60, 61, 150, 400]) {
      const flags = deliveryFlags(critical({ staleAfterSeconds: 120 }), CREATED + lag * 1000);
      const delayed = lag > REPLAY_LAG_SECONDS || lag > 120;
      expect(flags.stale || flags.replay).toBe(delayed);
    }
  });
});

describe("withDeliveryFlags", () => {
  const flags = { priority: "bulk" as const, event_ts: "2026-10-14T12:00:00.000Z", stale: true, replay: false };

  it("adds the flags beside the payload fields and overwrites same-named keys a producer set", () => {
    expect(withDeliveryFlags({ type: "alert", stale: false, kind: "fill" }, flags)).toEqual({
      type: "alert",
      kind: "fill",
      ...flags,
    });
  });

  it("wraps a non-object payload so the flags always have an object to live in", () => {
    expect(withDeliveryFlags(null, flags)).toEqual({ value: null, ...flags });
    expect(withDeliveryFlags([1, 2], flags)).toEqual({ value: [1, 2], ...flags });
  });
});
