"use client";

import { useEffect, useState } from "react";
import { formatBeijingTime } from "@/src/modules/format";
import type { MaDeviationBoard } from "@/src/modules/ma-deviation";

const REFRESH_MS = 30_000;

function pct(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function pctClass(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "muted";
}

function barWidth(value: number | null): number {
  if (value === null || Number.isNaN(value)) return 0;
  return Math.min(100, Math.abs(value) * 20);
}

export function MaDeviationBoard({ initialBoard }: { initialBoard: MaDeviationBoard }) {
  const [board, setBoard] = useState(initialBoard);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/ma-deviation");
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (
          typeof data === "object" &&
          data !== null &&
          "board" in data &&
          typeof (data as { board: unknown }).board === "object" &&
          (data as { board: unknown }).board !== null &&
          Array.isArray(((data as { board: { rows: unknown } }).board).rows)
        ) {
          setBoard((data as { board: MaDeviationBoard }).board);
          setLastUpdated(new Date().toISOString());
        }
      } catch {
        // Keep the last good board; the next tick retries.
      }
    };
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const rows = board.rows;
  const available = rows.filter((row) => row.w !== null);

  return (
    <div>
      <section aria-label="市场瞬时趋势仪表">
        <h2>市场瞬时趋势</h2>
        <p className="muted">
          数据更新于 {formatBeijingTime(board.fetchedAt)}
          {lastUpdated ? `；本页刷新于 ${formatBeijingTime(lastUpdated)}` : null}
        </p>
        {board.meanW !== null && board.positiveShare !== null ? (
          <p>
            平均加权偏离 <span className={pctClass(board.meanW)}>{pct(board.meanW)}</span>
            {"　"}W 为正占比 <span>{Math.round(board.positiveShare * 100)}%</span>
            <span className="muted">（共 {available.length} 只）</span>
          </p>
        ) : (
          <p className="muted">暂无可用数据</p>
        )}
        <p className="muted">
          读法：W 为正表示价格在 5 分钟 MA20 上方且近期偏离加权为正；W 变化为正表示瞬时趋势在加强，为负表示在走弱。
          最新一根是未收盘的形成中 K 线，W 会随盘中价格实时变动。
        </p>
      </section>

      <section aria-label="标的加权偏离排行">
        <h2>加权偏离排行（W 从高到低）</h2>
        {rows.length === 0 ? (
          <p className="muted">暂无数据</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>标的</th>
                <th>最新价</th>
                <th>最新偏离</th>
                <th>加权偏离 W</th>
                <th>上一窗口 W</th>
                <th>W 变化</th>
                <th aria-label="W 强弱条">强弱</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.symbol}>
                  <td>{row.symbol}</td>
                  <td>{Number.isNaN(row.lastClose) ? "—" : row.lastClose.toFixed(2)}</td>
                  <td className={pctClass(row.devLatest)}>{pct(row.devLatest)}</td>
                  <td className={pctClass(row.w)}>{pct(row.w)}</td>
                  <td className={pctClass(row.wPrev)}>{pct(row.wPrev)}</td>
                  <td className={pctClass(row.wChange)}>
                    {row.wChange === null ? "—" : `${row.wChange > 0 ? "+" : ""}${row.wChange.toFixed(2)}pp`}
                  </td>
                  <td>
                    <div
                      aria-hidden="true"
                      style={{
                        width: `${barWidth(row.w)}px`,
                        maxWidth: "100px",
                        height: "8px",
                        background:
                          row.w === null ? "var(--muted, #888)" : row.w > 0 ? "var(--up)" : "var(--down)",
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
