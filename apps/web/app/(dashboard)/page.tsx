import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { loadSourceHealth } from "@/src/modules/health/query";
import { buildHomeOverview, type HomeHealthView } from "@/src/modules/home/overview";
import { loadPanelData } from "@/src/modules/panel-data";
import { getNavItems } from "@/src/modules/registry";
import { sourceLabel } from "@/src/modules/sources";

export const metadata: Metadata = { title: "功能目录" };
export const dynamic = "force-dynamic";

export default async function DashboardHome() {
  const health = await loadPanelData("source_health", loadSourceHealth);
  const overview = buildHomeOverview({ panels: getNavItems(), health, nowMs: Date.now() });

  return (
    <PanelFrame
      title="功能目录"
      subtitle="进入已有的行情、新闻、健康与告警等面板。上方状态只来自数据源健康记录，不使用示例数据。"
    >
      <HomeHealthSection health={overview.health} />
      <h2>全部面板</h2>
      <ul className="catalog">
        {overview.panels.map((panel) => (
          <li key={panel.id}>
            <Link href={panel.href} className="catalog-card">
              <strong>{panel.title}</strong>
              <span>{panel.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </PanelFrame>
  );
}

function HomeHealthSection({ health }: { health: HomeHealthView }) {
  if (health.kind === "error") {
    return <ErrorState message={health.message} />;
  }
  if (health.kind === "empty") {
    return <EmptyState title="暂无数据源记录" hint="采集尚未写入 source_health 时，这里不会显示正常或过期计数。" />;
  }

  const staleLabels = health.staleSourceIds.map((id) => sourceLabel(id)).join("、");
  return (
    <section className="home-health" aria-label="数据源可用状态">
      <p className="meta">
        <span className={health.status === "ok" ? "badge badge-ok" : "badge badge-bad"}>
          {health.status === "ok" ? "数据源全部正常" : "存在过期数据源"}
        </span>
        <span>检查时间 {health.checkedAtLabel}</span>
        <Link href="/health">查看详情</Link>
      </p>
      <div className="stat-row" aria-label="数据源统计">
        <div className="stat">
          <strong>{health.healthy}</strong>
          <span>正常</span>
        </div>
        <div className="stat">
          <strong>{health.stale}</strong>
          <span>过期</span>
        </div>
        <div className="stat">
          <strong>{health.disabled}</strong>
          <span>未启用</span>
        </div>
      </div>
      {health.staleSourceIds.length > 0 ? (
        <p className="meta">过期数据源：{staleLabels}</p>
      ) : null}
    </section>
  );
}

