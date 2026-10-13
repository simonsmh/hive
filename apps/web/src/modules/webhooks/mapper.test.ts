import { describe, expect, it } from "vitest";
import { summarizeDeliveries, toDeliveryView, toSubscriptionView, type DeliveryRow, type SubscriptionRow } from "./mapper";

const subscription: SubscriptionRow = {
  id: "11111111-2222-3333-4444-555555555555",
  agent_name: "trader-bot",
  url: "https://agent.example.com/hook",
  event_types: ["news"],
  filters: { keywords: ["黄金"] },
  enabled: true,
  secret_id: "99999999-8888-7777-6666-555555555555",
  created_at: "2026-10-13T10:00:00Z",
  updated_at: "2026-10-13T10:00:00Z",
};

function delivery(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: 1,
    event_type: "news",
    event_key: "news:1",
    status: "pending",
    attempts: 1,
    max_attempts: 6,
    next_attempt_at: "2026-10-13T12:01:00Z",
    response_status: 500,
    last_error: "HTTP 500",
    delivered_at: null,
    created_at: "2026-10-13T12:00:00Z",
    updated_at: "2026-10-13T12:00:00Z",
    webhook_subscriptions: { agent_name: "trader-bot" },
    ...overrides,
  };
}

describe("toSubscriptionView", () => {
  it("never exposes the Vault reference, only whether a secret is configured", () => {
    const view = toSubscriptionView(subscription);
    expect(view).not.toHaveProperty("secret_id");
    expect(view).not.toHaveProperty("secret");
    expect(view.secret_configured).toBe(true);
    expect(view.filters).toEqual({ keywords: ["黄金"] });
  });

  it("reports an unset secret and tolerates a non-object filters value", () => {
    const view = toSubscriptionView({ ...subscription, secret_id: null, filters: ["bad"] });
    expect(view.secret_configured).toBe(false);
    expect(view.filters).toEqual({});
  });
});

describe("toDeliveryView", () => {
  it("labels statuses in Chinese and reads the subscriber name from the embed in either shape", () => {
    expect(toDeliveryView(delivery()).status_label).toBe("待重试");
    expect(toDeliveryView(delivery({ status: "dead" })).status_label).toBe("已放弃");
    expect(toDeliveryView(delivery({ webhook_subscriptions: [{ agent_name: "alert-bot" }] })).agent_name).toBe("alert-bot");
    expect(toDeliveryView(delivery({ webhook_subscriptions: null })).agent_name).toBe("未知订阅");
  });

  it("maps an unexpected status to unknown rather than a misleading label", () => {
    const view = toDeliveryView(delivery({ status: "exploded" }));
    expect(view.status).toBe("unknown");
    expect(view.status_label).toBe("未知");
  });
});

describe("summarizeDeliveries", () => {
  it("counts each status and lists the newest dead or retrying deliveries with an error", () => {
    const summary = summarizeDeliveries(
      [
        delivery({ id: 1, status: "delivered", last_error: null, created_at: "2026-10-13T12:00:00Z" }),
        delivery({ id: 2, status: "dead", created_at: "2026-10-13T12:05:00Z" }),
        delivery({ id: 3, status: "pending", last_error: "timeout", created_at: "2026-10-13T12:10:00Z" }),
        delivery({ id: 4, status: "pending", last_error: null, created_at: "2026-10-13T12:11:00Z" }),
        delivery({ id: 5, status: "sending", last_error: null, created_at: "2026-10-13T12:12:00Z" }),
      ],
      24,
    );
    expect(summary.counts).toEqual({ pending: 2, sending: 1, delivered: 1, dead: 1 });
    expect(summary.recent_failures.map((d) => d.id)).toEqual(["3", "2"]);
    expect(summary.window_hours).toBe(24);
  });

  it("returns zero counts for an empty window", () => {
    expect(summarizeDeliveries([], 24)).toEqual({
      window_hours: 24,
      counts: { pending: 0, sending: 0, delivered: 0, dead: 0 },
      recent_failures: [],
    });
  });
});
