"use client";

import { useCallback, useState } from "react";
import type { ConditionalOrderView } from "@/src/modules/orders/mapper";
import { formatPrice } from "@/src/modules/format";

const STATUS_LABELS: Record<string, string> = {
  armed: "待命",
  primed: "已就绪",
  fired: "已触发",
  expired: "已过期",
  cancelled: "已取消",
  failed: "失败",
};

const TRIGGER_LABELS: Record<string, string> = {
  breakout: "突破",
  strong_close: "强势收盘",
  engulfing: "看涨吞没",
  hammer: "锤子线",
};

const TRIGGER_KINDS = ["breakout", "strong_close", "engulfing", "hammer"] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`);
  return body;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function stopLevelOf(order: ConditionalOrderView): number | null {
  if (order.setup_low === null) return null;
  const buffer = typeof order.params.stopBufferPct === "number" ? order.params.stopBufferPct : 1.5;
  return order.setup_low * (1 - buffer / 100);
}

export function OrdersManager({ initialOrders }: { initialOrders: ConditionalOrderView[] }) {
  const [orders, setOrders] = useState<ConditionalOrderView[]>(initialOrders);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [symbol, setSymbol] = useState("");
  const [lever, setLever] = useState("3");
  const [sz, setSz] = useState("0.01");
  const [theme, setTheme] = useState("");
  const [themeStopCapU, setThemeStopCapU] = useState("0.1");
  const [tpPct, setTpPct] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("14");
  const [interval, setIntervalValue] = useState("1D");
  const [minDrawdownPct, setMinDrawdownPct] = useState("10");
  const [rsiMax, setRsiMax] = useState("45");
  const [stopBufferPct, setStopBufferPct] = useState("1.5");
  const [triggers, setTriggers] = useState<ReadonlySet<string>>(new Set(["breakout", "strong_close", "engulfing"]));
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    const data = await api<{ orders: ConditionalOrderView[] }>("/api/conditional-orders");
    setOrders(data.orders);
  }, []);

  const run = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      setNotice(null);
      try {
        const message = await action();
        await refresh();
        setNotice(message);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "操作失败");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const create = useCallback(() => {
    const bare = symbol.trim().toUpperCase();
    if (!bare) return;
    const instId = bare.includes("-") ? bare : `${bare}-USDT-SWAP`;
    void run(async () => {
      await api("/api/conditional-orders", {
        method: "POST",
        body: JSON.stringify({
          instId,
          mode: "live",
          lever: Number(lever),
          sz: sz.trim(),
          theme: theme.trim(),
          themeStopCapU: Number(themeStopCapU),
          tpPct: tpPct.trim() === "" ? null : Number(tpPct),
          expiresInDays: Number(expiresInDays),
          note: note.trim() === "" ? null : note.trim(),
          params: {
            interval,
            minDrawdownPct: Number(minDrawdownPct),
            rsiMax: rsiMax.trim() === "" ? null : Number(rsiMax),
            stopBufferPct: Number(stopBufferPct),
            triggers: TRIGGER_KINDS.filter((kind) => triggers.has(kind)),
          },
        }),
      });
      setSymbol("");
      return `已创建 ${instId} 条件单，评估器将在 3 分钟内开始盯盘`;
    });
  }, [symbol, lever, sz, theme, themeStopCapU, tpPct, expiresInDays, interval, minDrawdownPct, rsiMax, stopBufferPct, triggers, note, run]);

  const cancel = useCallback(
    (order: ConditionalOrderView) => {
      if (!window.confirm(`确认取消 ${order.inst_id} 条件单？取消后不会再触发下单。`)) return;
      void run(async () => {
        await api("/api/conditional-orders", { method: "PATCH", body: JSON.stringify({ id: order.id }) });
        return `已取消 ${order.inst_id} 条件单`;
      });
    },
    [run],
  );

  const toggleTrigger = (kind: string) => {
    setTriggers((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const active = orders.filter((order) => order.status === "armed" || order.status === "primed");
  const primed = orders.filter((order) => order.status === "primed");
  const fired = orders.filter((order) => order.status === "fired");

  return (
    <div className="ord-manager">
      <div className="stat-row" aria-label="条件单统计">
        <div className="stat">
          <strong>{active.length}</strong>
          <span>盯盘中</span>
        </div>
        <div className="stat">
          <strong>{primed.length}</strong>
          <span>已就绪（等触发）</span>
        </div>
        <div className="stat">
          <strong>{fired.length}</strong>
          <span>已触发</span>
        </div>
      </div>
      {notice ? (
        <p className="meta" role="status">
          {notice}
        </p>
      ) : null}

      <h2>条件单</h2>
      {orders.length === 0 ? (
        <p className="muted">暂无条件单。用下方表单创建：先等砸盘砸够（回撤 + 超卖就绪），再等反转确认才真下单。</p>
      ) : (
        <ul className="list">
          {orders.map((order) => {
            const stop = stopLevelOf(order);
            const cancellable = order.status === "armed" || order.status === "primed";
            return (
              <li key={order.id} className="list-item ord-row">
                <div className="ord-main">
                  <div className="list-item-head">
                    <strong>{order.symbol}</strong>
                    <span className={order.status === "primed" || order.status === "fired" ? "badge badge-ok" : order.status === "failed" ? "badge badge-bad" : "badge"}>
                      {STATUS_LABELS[order.status] ?? order.status}
                    </span>
                    <span className="badge badge-accent">反转抄底</span>
                  </div>
                  <p className="meta">
                    {order.inst_id} · {order.lever}x · {order.sz} 张 · 主题 {order.theme} · 止损上限 {order.theme_stop_cap_u}U
                    {order.tp_pct !== null ? ` · 止盈 +${order.tp_pct}%` : ""} · 确认周期{" "}
                    {typeof order.params.interval === "string" ? order.params.interval : "1D"}
                  </p>
                  {order.setup_low !== null ? (
                    <p className="meta">
                      见底低点 {formatPrice(order.setup_low)}
                      {order.drawdown_pct !== null ? ` · 回撤 ${order.drawdown_pct}%` : ""}
                      {stop !== null ? ` · 止损位 ≈${formatPrice(stop)}` : ""}
                      {order.invalidations > 0 ? ` · 已作废重就绪 ${order.invalidations} 次` : ""}
                    </p>
                  ) : null}
                  {order.status === "fired" ? (
                    <p className="meta">
                      触发方式 {TRIGGER_LABELS[order.fire_trigger ?? ""] ?? order.fire_trigger} · {formatDateTime(order.fired_at)}
                      {order.ord_id ? ` · 订单 ${order.ord_id}` : ""}
                    </p>
                  ) : null}
                  {order.last_note ? <p className="meta">最近评估：{order.last_note}</p> : null}
                  <p className="meta">
                    有效期至 {formatDateTime(order.expires_at)}
                    {order.note ? ` · ${order.note}` : ""}
                  </p>
                </div>
                {cancellable ? (
                  <div className="sym-actions">
                    <button type="button" className="btn-ghost sym-danger" disabled={busy} onClick={() => cancel(order)}>
                      取消
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <h2>新建条件单（反转抄底）</h2>
      <p className="muted">
        两段式：先「就绪」——自 30 日高点回撤达到阈值且日线 RSI 够低；再「触发」——出现所选反转确认形态才市价买入，止损挂在见底低点下方，触发即推送通知。评估器每
        3 分钟一轮，下单走 order-submit 全部风控闸门。
      </p>
      <form
        className="ord-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label>
          标的代码
          <input type="text" value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="如 NVDA" required />
        </label>
        <label>
          杠杆
          <input type="number" value={lever} onChange={(event) => setLever(event.target.value)} min="1" max="125" step="1" required />
        </label>
        <label>
          张数
          <input type="text" value={sz} onChange={(event) => setSz(event.target.value)} placeholder="如 0.01" required />
        </label>
        <label>
          主题 theme
          <input type="text" value={theme} onChange={(event) => setTheme(event.target.value)} placeholder="如 reversal-oct" required />
        </label>
        <label>
          止损上限 (U)
          <input type="number" value={themeStopCapU} onChange={(event) => setThemeStopCapU(event.target.value)} min="0.01" max="0.1" step="0.01" required />
        </label>
        <label>
          止盈 %（可空）
          <input type="number" value={tpPct} onChange={(event) => setTpPct(event.target.value)} min="1" max="200" step="1" placeholder="不设" />
        </label>
        <label>
          有效天数
          <input type="number" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} min="1" max="31" step="1" required />
        </label>
        <label>
          确认周期
          <select value={interval} onChange={(event) => setIntervalValue(event.target.value)}>
            <option value="1D">日线（稳）</option>
            <option value="15m">15 分钟（快）</option>
          </select>
        </label>
        <label>
          最小回撤 %
          <input type="number" value={minDrawdownPct} onChange={(event) => setMinDrawdownPct(event.target.value)} min="1" max="60" step="1" required />
        </label>
        <label>
          RSI 上限（可空）
          <input type="number" value={rsiMax} onChange={(event) => setRsiMax(event.target.value)} min="5" max="70" step="1" placeholder="不限制" />
        </label>
        <label>
          止损缓冲 %
          <input type="number" value={stopBufferPct} onChange={(event) => setStopBufferPct(event.target.value)} min="0.1" max="10" step="0.1" required />
        </label>
        <label>
          备注（可空）
          <input type="text" value={note} onChange={(event) => setNote(event.target.value)} placeholder="如 等财报后反弹" />
        </label>
        <fieldset className="ord-triggers">
          <legend className="meta">触发形态（任一）</legend>
          {TRIGGER_KINDS.map((kind) => (
            <label key={kind}>
              <input type="checkbox" checked={triggers.has(kind)} onChange={() => toggleTrigger(kind)} />
              {TRIGGER_LABELS[kind]}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn ord-submit" disabled={busy || symbol.trim() === "" || theme.trim() === "" || triggers.size === 0}>
          创建条件单
        </button>
      </form>
    </div>
  );
}
