"use client";

import { useEffect, useState } from "react";
import type { MarketBoard } from "@/src/modules/market/board";

const REFRESH_MS = 60_000;

function isEmptyBoard(board: MarketBoard): boolean {
  return board.industryUp.length === 0 && board.industryDown.length === 0 && board.breadth === null;
}

const MARKET_TABS = [
  { id: "all", label: "全部A股" },
  { id: "sh", label: "上证A股" },
  { id: "sz", label: "深证A股" },
  { id: "bj", label: "北证A股" },
  { id: "gem", label: "创业板" },
  { id: "star", label: "科创板" },
  { id: "hs300", label: "沪深300" },
] as const;

function pct(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function pctClass(value: number | null): string {
  if (value === null) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "muted";
}

function RankTable<T extends { thscode: string; name: string }>({
  title,
  rows,
  valueOf,
}: {
  title: string;
  rows: T[];
  valueOf: (row: T) => number | null;
}) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">暂无数据</p>
      ) : (
        <ul className="list">
          {rows.map((row) => {
            const value = valueOf(row);
            return (
              <li key={row.thscode} className="quote-row">
                <span>{row.name}</span>
                <span className={pctClass(value)}>{pct(value)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function MarketBoard({ initialBoard }: { initialBoard: MarketBoard }) {
  const [board, setBoard] = useState(initialBoard);
  const [market, setMarket] = useState<string>("all");

  // The collector writes during trading hours, so the board refreshes itself
  // while the page stays open; an initially empty board (before the first
  // write of the day) also transitions to data without a manual reload.
  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/market");
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (
          typeof data === "object" &&
          data !== null &&
          "board" in data &&
          typeof (data as { board: unknown }).board === "object" &&
          (data as { board: unknown }).board !== null &&
          Array.isArray(((data as { board: { industryUp: unknown } }).board).industryUp)
        ) {
          setBoard((data as { board: MarketBoard }).board);
        }
      } catch {
        // Keep the last good board; the next tick retries.
      }
    };
    if (isEmptyBoard(initialBoard)) void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [initialBoard]);

  if (isEmptyBoard(board)) {
    return (
      <div className="empty">
        <strong>暂无市场数据</strong>
        <span>采集器会在下一个交易日盘中写入行业榜与宽度数据；本页每 60 秒自动刷新。</span>
      </div>
    );
  }
  const breadth = board.breadth;
  const counts = breadth?.markets?.[market] ?? null;
  const bins = counts?.bins ?? (market === "all" ? breadth?.bins ?? null : null);
  const totals = counts ?? (market === "all" && breadth ? breadth : null);
  const maxBin = bins ? Math.max(0, ...bins) : 0;

  return (
    <div>
      <section aria-label="行业涨幅榜">
        <h2>行业涨幅榜</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <RankTable title="涨幅前十" rows={board.industryUp} valueOf={(row) => row.pct} />
          <RankTable title="跌幅前十" rows={board.industryDown} valueOf={(row) => row.pct} />
        </div>
      </section>

      <section aria-label="行业 5 分钟涨速">
        <h2>行业 5 分钟涨速</h2>
        <p className="muted">取约 5 分钟前快照对比，采集每 2 分钟一次；开盘初几分钟暂无数据。</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <RankTable title="涨速前十" rows={board.speedUp} valueOf={(row) => row.speedPct} />
          <RankTable title="跌速前十" rows={board.speedDown} valueOf={(row) => row.speedPct} />
        </div>
      </section>

      <section aria-label="涨跌分布">
        <h2>涨跌分布</h2>
        {breadth ? (
          <>
            <p>
              涨 <span className="up">{breadth.up}</span> 平 <span className="muted">{breadth.flat}</span> 跌{" "}
              <span className="down">{breadth.down}</span>
              {board.limitUp !== null ? (
                <>
                   涨停 <span className="up">{board.limitUp}</span>
                </>
              ) : null}
              {board.limitDown !== null ? (
                <>
                   跌停 <span className="down">{board.limitDown}</span>
                </>
              ) : null}
              <span className="muted"> 共 {breadth.total} 只</span>
            </p>
            <nav className="chips" aria-label="选择市场">
              {MARKET_TABS.filter((tab) => tab.id === "all" || breadth.markets?.[tab.id]).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="chip"
                  aria-current={market === tab.id ? "true" : undefined}
                  onClick={() => setMarket(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
            {totals ? (
              <p className="muted">
                {MARKET_TABS.find((tab) => tab.id === market)?.label}：涨 {totals.up} 平 {totals.flat} 跌 {totals.down} 共{" "}
                {totals.total} 只
              </p>
            ) : null}
            {bins ? (
              <div aria-label="涨跌幅分布直方图" style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "160px" }}>
                {bins.map((count, index) => {
                  const bin = index - 10;
                  const height = maxBin > 0 ? Math.round((count / maxBin) * 140) : 0;
                  const color = bin > 0 ? "var(--up)" : bin < 0 ? "var(--down)" : "var(--muted, #888)";
                  return (
                    <div key={bin} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" }}>
                      <span className="muted" style={{ fontSize: "0.75rem" }}>
                        {count}
                      </span>
                      <div title={`${bin}%档：${count} 只`} style={{ width: "100%", height: `${height}px`, background: color }} />
                      <span className="muted" style={{ fontSize: "0.75rem" }}>
                        {bin}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">直方图分档尚未采集（旧版宽度数据只有涨跌总数），下一个宽度采集点后出现。</p>
            )}
            <p className="muted">分档按涨跌幅向下取整：-3 档即 -3% 至 -2%，+10 档含 10% 以上。</p>
          </>
        ) : (
          <p className="muted">暂无宽度数据，宽度每 30 分钟采集一次。</p>
        )}
      </section>
    </div>
  );
}
