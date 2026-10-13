import type { Metadata } from "next";
import { EmptyState, ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { formatAge, formatBeijingTime } from "@/src/modules/format";
import { WebhookDeliverySection } from "@/src/components/dashboard/WebhookDeliverySection";
import { buildHealthReport, type SourceHealthRow, type SourceHealthView } from "@/src/modules/health/mapper";
import { loadSourceHealth } from "@/src/modules/health/query";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";
import { sourceLabel } from "@/src/modules/sources";
import { loadDeliverySummary } from "@/src/modules/webhooks/query";

const panel = requirePanel("health");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const [health, deliveries] = await Promise.all([
    loadPanelData("source_health", loadSourceHealth),
    loadPanelData("webhook_deliveries", loadDeliverySummary),
  ]);
  return (
    <PanelFrame title={panel.title} subtitle="各数据源最近一次成功采集。已启用且过期的数据源会使 /api/health 返回 503。">
      {health.ok ? <HealthBody rows={health.data} /> : <ErrorState message={health.message} />}
      {deliveries.ok ? <WebhookDeliverySection summary={deliveries.data} /> : <ErrorState message={deliveries.message} />}
    </PanelFrame>
  );
}

function HealthBody({ rows }: { rows: SourceHealthRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="暂无数据源记录" hint="Worker 启动并完成首次采集后，这里会显示各数据源状态。" />;
  }

  const { report } = buildHealthReport(rows, Date.now());
  const healthy = report.sources.filter((s) => s.enabled && !s.stale).length;
  const stale = report.sources.filter((s) => s.enabled && s.stale).length;
  const disabled = report.sources.filter((s) => !s.enabled).length;

  return (
    <>
      <p className="meta">
        <span className={report.status === "ok" ? "badge badge-ok" : "badge badge-bad"}>
          {report.status === "ok" ? "全部正常" : "存在过期数据源"}
        </span>
        <span>检查时间 {formatBeijingTime(report.checked_at)}</span>
      </p>
      <div className="stat-row" aria-label="数据源统计">
        <div className="stat">
          <strong>{healthy}</strong>
          <span>正常</span>
        </div>
        <div className="stat">
          <strong>{stale}</strong>
          <span>过期</span>
        </div>
        <div className="stat">
          <strong>{disabled}</strong>
          <span>未启用</span>
        </div>
      </div>
      <ul className="list">
        {report.sources.map((source) => (
          <SourceItem key={source.source} source={source} />
        ))}
      </ul>
    </>
  );
}

function SourceItem({ source }: { source: SourceHealthView }) {
  const badge = !source.enabled ? (
    <span className="badge">未启用</span>
  ) : source.stale ? (
    <span className="badge badge-bad">已过期</span>
  ) : (
    <span className="badge badge-ok">正常</span>
  );

  return (
    <li className="list-item">
      <div className="list-item-head">
        <strong>{sourceLabel(source.source)}</strong>
        {badge}
      </div>
      <div className="meta">
        <span>最后成功 {formatBeijingTime(source.last_success_at)}</span>
        <span>{formatAge(source.age_minutes)}</span>
        <span>阈值 {source.max_staleness_minutes} 分钟</span>
        <span>连续失败 {source.consecutive_failures}</span>
      </div>
      {source.last_error ? (
        <p className="meta">
          最后错误 <code className="code">{source.last_error}</code>
        </p>
      ) : null}
    </li>
  );
}
