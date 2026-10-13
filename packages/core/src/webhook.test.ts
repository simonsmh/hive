import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_BACKOFF_SECONDS,
  SubscriptionInputError,
  computeBackoffSeconds,
  parseSubscriptionFilters,
  parseSubscriptionInput,
  signWebhookBody,
  verifyWebhookSignature,
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

  it("rejects non-object bodies", () => {
    expect(() => parseSubscriptionInput([], { requireAll: true })).toThrow(SubscriptionInputError);
    expect(() => parseSubscriptionInput(null, { requireAll: false })).toThrow(/JSON object/);
  });
});
