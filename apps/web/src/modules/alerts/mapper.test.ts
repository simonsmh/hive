import { describe, expect, it } from "vitest";
import { toAlertView, type AlertRow } from "./mapper";

const base: AlertRow = {
  id: 7,
  kind: "source_stale",
  symbol: null,
  payload: {},
  triggered_at: "2026-10-13T12:00:00Z",
};

describe("toAlertView", () => {
  it("summarises a stale source with its name and the readable details", () => {
    const view = toAlertView({
      ...base,
      payload: { source: "okx", last_success_at: "2026-10-13T11:00:00Z", consecutive_failures: 3, last_error: "HTTP 429" },
    });
    expect(view.kindLabel).toBe("数据源过期");
    expect(view.summary).toBe("数据源 okx 超过允许的更新间隔");
    expect(view.id).toBe("7");
    expect(view.details).toEqual([
      { label: "数据源", value: "okx" },
      { label: "最后成功", value: "2026-10-13T11:00:00Z" },
      { label: "连续失败", value: "3" },
      { label: "最后错误", value: "HTTP 429" },
    ]);
  });

  it("labels market alerts with the symbol and keeps unknown kinds as-is", () => {
    const view = toAlertView({ ...base, id: "8", kind: "price_cross", symbol: "BTC", payload: { price: 90000, threshold: 90000 } });
    expect(view.summary).toBe("价格穿越 · BTC");
    expect(view.details).toEqual([
      { label: "价格", value: "90000" },
      { label: "阈值", value: "90000" },
    ]);

    expect(toAlertView({ ...base, kind: "mystery" }).kindLabel).toBe("mystery");
  });

  it("drops null fields, stringifies nested values and truncates very long ones", () => {
    const long = "e".repeat(300);
    const view = toAlertView({ ...base, payload: { source: null, nested: { a: 1 }, last_error: long } });
    expect(view.details).toEqual([
      { label: "nested", value: '{"a":1}' },
      { label: "最后错误", value: `${"e".repeat(119)}…` },
    ]);
  });

  it("caps the number of detail rows", () => {
    const payload = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    expect(toAlertView({ ...base, kind: "long_wick", payload }).details).toHaveLength(6);
  });

  it("tolerates a payload that is not an object", () => {
    const view = toAlertView({ ...base, payload: ["x"] });
    expect(view.details).toEqual([]);
    expect(view.summary).toBe("数据源 未知 超过允许的更新间隔");
  });
});
