import { DELIVERY_STATUS_LABELS, DELIVERY_STATUSES, type DeliverySummary } from "@/src/modules/webhooks/mapper";
import { formatBeijingTime } from "@/src/modules/format";
import { EmptyState } from "./PanelFrame";

export function WebhookDeliverySection({ summary }: { summary: DeliverySummary }) {
  const total = DELIVERY_STATUSES.reduce((sum, status) => sum + summary.counts[status], 0);

  return (
    <section className="webhook-summary" aria-labelledby="webhook-summary-title">
      <h2 id="webhook-summary-title">Agent 推送（最近 {summary.window_hours} 小时）</h2>
      {total === 0 ? (
        <EmptyState title="暂无推送记录" hint="有订阅且命中规则的新闻或告警会在这里显示投递状态。" />
      ) : (
        <div className="stat-row" aria-label="推送统计">
          {DELIVERY_STATUSES.map((status) => (
            <div className="stat" key={status}>
              <strong>{summary.counts[status]}</strong>
              <span>{DELIVERY_STATUS_LABELS[status]}</span>
            </div>
          ))}
        </div>
      )}
      {summary.recent_failures.length > 0 ? (
        <ul className="list">
          {summary.recent_failures.map((delivery) => (
            <li className="list-item" key={delivery.id}>
              <div className="list-item-head">
                <strong>{delivery.agent_name}</strong>
                <span className={delivery.status === "dead" ? "badge badge-bad" : "badge"}>{delivery.status_label}</span>
                <span className="badge">{delivery.event_type}</span>
              </div>
              <div className="meta">
                <span>
                  第 {delivery.attempts}/{delivery.max_attempts} 次
                </span>
                <span>{formatBeijingTime(delivery.created_at)}</span>
                {delivery.status === "pending" ? <span>下次重试 {formatBeijingTime(delivery.next_attempt_at)}</span> : null}
              </div>
              {delivery.last_error ? (
                <p className="meta">
                  最后错误 <code className="code">{delivery.last_error}</code>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
