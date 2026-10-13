import type { Metadata } from "next";
import { EmptyState, ErrorState, PanelFrame } from "@/src/components/dashboard/PanelFrame";
import { formatBeijingTime, formatCredibility } from "@/src/modules/format";
import { loadPanelData } from "@/src/modules/panel-data";
import { requirePanel } from "@/src/modules/registry";
import { groupNewsByEvent, type NewsEventView } from "@/src/modules/news/mapper";
import { NEWS_EVENT_LIMIT, loadRecentNews } from "@/src/modules/news/query";

const panel = requirePanel("news");

export const metadata: Metadata = { title: panel.title };
export const dynamic = "force-dynamic";

export default async function NewsPage() {
  const result = await loadPanelData("news", async () => {
    const { events, items } = await loadRecentNews();
    return groupNewsByEvent(events, items);
  });

  return (
    <PanelFrame title={panel.title} subtitle={`最近 ${NEWS_EVENT_LIMIT} 个新闻事件，按首次发布时间倒序`}>
      {!result.ok ? (
        <ErrorState message={result.message} />
      ) : result.data.length === 0 ? (
        <EmptyState title="暂无新闻事件" hint="新闻采集接入后，同一事件的多条来源会聚合显示在这里。" />
      ) : (
        <ul className="list">
          {result.data.map((event) => (
            <EventItem key={event.id} event={event} />
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

function EventItem({ event }: { event: NewsEventView }) {
  return (
    <li className="list-item">
      <div className="list-item-head">
        <strong>{event.title}</strong>
      </div>
      <div className="meta">
        <span>{formatBeijingTime(event.publishedAt)}</span>
        <span>{event.items.length} 条来源</span>
      </div>
      {event.items.length > 0 ? (
        <ul className="news-items">
          {event.items.map((item) => (
            <li key={item.id} className="meta">
              <span className="badge">{item.source}</span>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.title}
                </a>
              ) : (
                <span>{item.title}</span>
              )}
              <span>
                {formatBeijingTime(item.publishedAt)} · 可信度 {formatCredibility(item.credibility)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
