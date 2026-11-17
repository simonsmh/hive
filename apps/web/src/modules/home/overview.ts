import { formatBeijingTime } from "../format";
import { buildHealthReport, type SourceHealthRow } from "../health/mapper";
import type { PanelResult } from "../panel-data";
import type { PanelRegistration } from "../registry";

export interface HomePanelLink {
  id: string;
  title: string;
  href: string;
  summary: string;
}

export type HomeHealthView =
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | {
      kind: "ready";
      status: "ok" | "degraded";
      healthy: number;
      stale: number;
      disabled: number;
      checkedAtLabel: string;
      staleSourceIds: string[];
    };

export interface HomeOverview {
  panels: HomePanelLink[];
  health: HomeHealthView;
}

/**
 * Builds the home catalog view from real panel registrations and a health load result.
 * Does not invent counts, sample rows, or panels that are not in the registry.
 */
export function buildHomeOverview(input: {
  panels: readonly PanelRegistration[];
  health: PanelResult<SourceHealthRow[]>;
  nowMs: number;
}): HomeOverview {
  const panels = input.panels.map((panel) => ({
    id: panel.id,
    title: panel.title,
    href: panel.href,
    summary: panel.summary,
  }));

  if (!input.health.ok) {
    return { panels, health: { kind: "error", message: input.health.message } };
  }
  if (input.health.data.length === 0) {
    return { panels, health: { kind: "empty" } };
  }

  const { report } = buildHealthReport(input.health.data, input.nowMs);
  const staleSourceIds = report.sources.filter((source) => source.enabled && source.stale).map((source) => source.source);
  return {
    panels,
    health: {
      kind: "ready",
      status: report.status,
      healthy: report.sources.filter((source) => source.enabled && !source.stale).length,
      stale: staleSourceIds.length,
      disabled: report.sources.filter((source) => !source.enabled).length,
      checkedAtLabel: formatBeijingTime(report.checked_at),
      staleSourceIds,
    },
  };
}
