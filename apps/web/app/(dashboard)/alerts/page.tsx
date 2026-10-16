import type { Metadata } from "next";
import { Fragment } from "react";
import { LiveRefresh } from "@/src/components/dashboard/LiveRefresh";
import { EmptyState, ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { formatBeijingTime } from "@/src/modules/format";
import { toAlertView, type AlertView } from "@/src/modules/alerts/mapper";
import { ALERT_LIMIT, digestAlertList, loadRecentAlerts } from "@/src/modules/alerts/query";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";

const panel = requirePanel("alerts");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const result = await loadPanelData("alerts", async () => (await loadRecentAlerts()).map(toAlertView));

  return (
    <PanelFrame title={panel.title} subtitle={`最近 ${ALERT_LIMIT} 条告警，按触发时间倒序`}>
      {result.ok ? (
        <LiveRefresh
          topic="alerts"
          field="digest"
          baseline={digestAlertList(result.data)}
          label="告警有更新，点击刷新"
        />
      ) : null}
      {!result.ok ? (
        <ErrorState message={result.message} />
      ) : result.data.length === 0 ? (
        <EmptyState title="暂无告警" hint="数据源过期或规则触发时，告警会记录在这里。" />
      ) : (
        <ul className="list">
          {result.data.map((alert) => (
            <AlertItem key={alert.id} alert={alert} />
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

function kindBadgeClass(alert: AlertView): string {
  if (alert.kind === "source_recovered") return "badge badge-ok";
  if (alert.kind === "source_stale") return "badge badge-bad";
  return "badge badge-accent";
}

function AlertItem({ alert }: { alert: AlertView }) {
  return (
    <li className="list-item">
      <div className="list-item-head">
        <span className={kindBadgeClass(alert)}>{alert.kindLabel}</span>
        {alert.symbol ? <span className="badge">{alert.symbol}</span> : null}
        {alert.resolved ? <span className="badge badge-ok">已恢复</span> : null}
        <span className="muted">{formatBeijingTime(alert.triggeredAt)}</span>
      </div>
      <p>
        {alert.summary} <span className="meta">严重程度 {alert.severityLabel}</span>
      </p>
      {alert.resolved && alert.resolvedAt ? <p className="meta">恢复时间 {formatBeijingTime(alert.resolvedAt)}</p> : null}
      {alert.details.length > 0 ? (
        <dl className="alert-details">
          {alert.details.map((detail, index) => (
            <Fragment key={`${detail.label}-${index}`}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
