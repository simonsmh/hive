import { describe, expect, it } from "vitest";
import type { SourceHealthRow } from "../health/mapper";
import { PANELS } from "../registry";
import { buildHomeOverview } from "./overview";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");

function panel(overrides: Partial<(typeof PANELS)[number]> = {}) {
  return {
    id: "news",
    title: "新闻",
    icon: "news" as const,
    href: "/news",
    order: 1,
    summary: "按首次发布时间浏览最近新闻事件",
    ...overrides,
  };
}

function row(overrides: Partial<SourceHealthRow> = {}): SourceHealthRow {
  return {
    source: "okx",
    enabled: true,
    last_success_at: "2026-11-15T11:59:00.000Z",
    consecutive_failures: 0,
    max_staleness_minutes: 3,
    last_error: null,
    ...overrides,
  };
}

describe("buildHomeOverview", () => {
  it("lists only the supplied panels and their summaries", () => {
    const overview = buildHomeOverview({
      panels: [panel({ id: "quotes", title: "行情", href: "/quotes", summary: "查看报价" }), panel()],
      health: { ok: false, message: "数据暂时无法加载，请稍后重试" },
      nowMs: NOW,
    });
    expect(overview.panels).toEqual([
      { id: "quotes", title: "行情", href: "/quotes", summary: "查看报价" },
      { id: "news", title: "新闻", href: "/news", summary: "按首次发布时间浏览最近新闻事件" },
    ]);
  });

  it("forwards a load error without inventing health counts", () => {
    const overview = buildHomeOverview({
      panels: [panel()],
      health: { ok: false, message: "服务端配置缺失，请检查环境变量" },
      nowMs: NOW,
    });
    expect(overview.health).toEqual({ kind: "error", message: "服务端配置缺失，请检查环境变量" });
  });

  it("uses an empty state when source_health has no rows", () => {
    const overview = buildHomeOverview({ panels: [panel()], health: { ok: true, data: [] }, nowMs: NOW });
    expect(overview.health).toEqual({ kind: "empty" });
  });

  it("summarizes ready health from real rows, including stale source ids", () => {
    const overview = buildHomeOverview({
      panels: PANELS,
      health: {
        ok: true,
        data: [
          row({ source: "okx" }),
          row({ source: "jin10", last_success_at: "2026-11-15T10:00:00.000Z", consecutive_failures: 34 }),
          row({ source: "google", enabled: false, last_success_at: null }),
        ],
      },
      nowMs: NOW,
    });
    expect(overview.health).toEqual({
      kind: "ready",
      status: "degraded",
      healthy: 1,
      stale: 1,
      disabled: 1,
      checkedAtLabel: "2026/11/15 20:00:00",
      staleSourceIds: ["jin10"],
    });
    expect(overview.panels.map((item) => item.id)).toEqual(PANELS.map((item) => item.id));
  });
});
