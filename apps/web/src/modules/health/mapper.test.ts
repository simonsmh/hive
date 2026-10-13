import { describe, expect, it } from "vitest";
import { buildHealthReport, type SourceHealthRow } from "./mapper";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

function row(overrides: Partial<SourceHealthRow>): SourceHealthRow {
  return {
    source: "okx",
    enabled: true,
    last_success_at: "2026-10-13T11:59:00.000Z",
    consecutive_failures: 0,
    max_staleness_minutes: 3,
    last_error: null,
    ...overrides,
  };
}

describe("buildHealthReport", () => {
  it("reports ok when every enabled source is fresh", () => {
    const { report, degraded } = buildHealthReport([row({})], NOW);
    expect(degraded).toBe(false);
    expect(report.status).toBe("ok");
    expect(report.checked_at).toBe("2026-10-13T12:00:00.000Z");
    expect(report.sources[0]).toMatchObject({ source: "okx", age_minutes: 1, stale: false });
  });

  it("marks a source stale once its age exceeds max_staleness_minutes", () => {
    const { report, degraded } = buildHealthReport([row({ last_success_at: "2026-10-13T11:56:00.000Z" })], NOW);
    expect(degraded).toBe(true);
    expect(report.status).toBe("degraded");
    expect(report.sources[0]).toMatchObject({ age_minutes: 4, stale: true });
  });

  it("treats a source with no successful poll ever as stale with null age", () => {
    const { report } = buildHealthReport([row({ last_success_at: null })], NOW);
    expect(report.sources[0]).toMatchObject({ age_minutes: null, stale: true });
    expect(report.status).toBe("degraded");
  });

  it("ignores stale sources that are disabled", () => {
    const { report, degraded } = buildHealthReport(
      [row({ source: "yahoo", enabled: false, last_success_at: null, max_staleness_minutes: 30 })],
      NOW,
    );
    expect(degraded).toBe(false);
    expect(report.status).toBe("ok");
    expect(report.sources[0]?.stale).toBe(true);
  });

  it("rounds age to one decimal place", () => {
    const { report } = buildHealthReport([row({ last_success_at: "2026-10-13T11:58:40.000Z", max_staleness_minutes: 10 })], NOW);
    expect(report.sources[0]?.age_minutes).toBe(1.3);
  });

  it("keeps the source row fields alongside the computed ones", () => {
    const input = row({ consecutive_failures: 2, last_error: "HTTP 429" });
    const { report } = buildHealthReport([input], NOW);
    expect(report.sources[0]).toEqual({ ...input, age_minutes: 1, stale: false });
  });

  it("returns an empty ok report when there are no sources", () => {
    const { report, degraded } = buildHealthReport([], NOW);
    expect(degraded).toBe(false);
    expect(report.sources).toEqual([]);
  });
});
