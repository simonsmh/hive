"use client";

import { useCallback, useState } from "react";
import type { TrendStrategyView } from "@/src/modules/trend/mapper";
import { formatPrice } from "@/src/modules/format";

const STATUS_LABELS: Record<string, string> = {
  armed: "待命",
  active: "持仓中",
  done: "已结束",
  expired: "已过期",
  cancelled: "已取消",
  failed: "失败",
};

const EVENT_LABELS: Record<string, string> = {
  watching: "观望（闸门未全过）",
  trigger_fired: "触发信号",
  shadow_open: "影子开仓",
  opened: "已开仓",
  open_skipped: "跳过开仓",
  open_failed: "开仓失败",
  add_planned: "计划加仓",
  shadow_add: "影子加仓",
  added: "已加仓",
  add_failed: "加仓失败",
  add_skipped_risk: "加仓被风控跳过",
  exit_triggered: "触发退出",
  shadow_exit: "影子退出",
  closed: "已平仓",
  close_failed: "平仓失败",
  position_gone: "仓位已消失",
  reconcile_planned: "计划对账止损",
  reconciled: "止损已对账",
  reconcile_failed: "止损对账失败",
  orphan_algos_cancelled: "已撤销残留止损单",
  expired: "已过期",
  eval_skip: "跳过评估",
  active_snapshot: "持仓快照",
};

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

export function TrendManager({ initialStrategies }: { initialStrategies: TrendStrategyView[] }) {
  const [strategies, setStrategies] = useState<TrendStrategyView[]>(initialStrategies);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [symbol, setSymbol] = useState("");
  const [mode, setMode] = useState("live");
  const [runMode, setRunMode] = useState("shadow");
  const [direction, setDirection] = useState("long");
  const [lever, setLever] = useState("20");
  const [firstSz, setFirstSz] = useState("0.01");
  const [theme, setTheme] = useState("");
  const [themeStopCapU, setThemeStopCapU] = useState("0.1");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [peers, setPeers] = useState("");
  const [peerMinCount, setPeerMinCount] = useState("0");
  const [expansionMultiple, setExpansionMultiple] = useState("1.25");
  const [volumeMultiple, setVolumeMultiple] = useState("1.5");
  const [addStepAtr, setAddStepAtr] = useState("0.5");
  const [maxAdds, setMaxAdds] = useState("3");
  const [atrDecayExitPct, setAtrDecayExitPct] = useState("28");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    const data = await api<{ strategies: TrendStrategyView[] }>("/api/trend-strategies");
    setStrategies(data.strategies);
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
    const peerInstIds = peers
      .split(/[,\s]+/)
      .map((part) => part.trim().toUpperCase())
      .filter((part) => part !== "")
      .map((part) => (part.includes("-") ? part : `${part}-USDT-SWAP`));
    void run(async () => {
      await api("/api/trend-strategies", {
        method: "POST",
        body: JSON.stringify({
          instId,
          mode,
          runMode,
          direction,
          lever: Number(lever),
          firstSz: firstSz.trim(),
          theme: theme.trim(),
          themeStopCapU: Number(themeStopCapU),
          expiresInDays: Number(expiresInDays),
          note: note.trim() === "" ? null : note.trim(),
          params: {
            peerInstIds,
            peerMinCount: Number(peerMinCount),
            expansionMultiple: Number(expansionMultiple),
            volumeMultiple: Number(volumeMultiple),
            addStepAtr: Number(addStepAtr),
            maxAdds: Number(maxAdds),
            atrDecayExitPct: Number(atrDecayExitPct),
          },
        }),
      });
      setSymbol("");
      return runMode === "live"
        ? `已创建 ${instId} 实盘趋势实例，评估器 3 分钟内开始盯盘，触发即真下单`
        : `已创建 ${instId} 影子实例，只模拟与记录事件，不会下单`;
    });
  }, [symbol, mode, runMode, direction, lever, firstSz, theme, themeStopCapU, expiresInDays, peers, peerMinCount, expansionMultiple, volumeMultiple, addStepAtr, maxAdds, atrDecayExitPct, note, run]);

  const cancel = useCallback(
    (strategy: TrendStrategyView) => {
      const warning =
        strategy.status === "active" && strategy.run_mode === "live"
          ? `确认取消 ${strategy.inst_id} 趋势实例？注意：取消只停止托管，当前仓位不会平仓，仅剩交易所止损单保护。`
          : `确认取消 ${strategy.inst_id} 趋势实例？取消后不会再触发任何动作。`;
      if (!window.confirm(warning)) return;
      void run(async () => {
        await api("/api/trend-strategies", { method: "PATCH", body: JSON.stringify({ id: strategy.id }) });
        return `已取消 ${strategy.inst_id} 趋势实例`;
      });
    },
    [run],
  );

  const armed = strategies.filter((s) => s.status === "armed");
  const active = strategies.filter((s) => s.status === "active");
  const shadowCount = strategies.filter((s) => s.run_mode === "shadow" && (s.status === "armed" || s.status === "active")).length;

  return (
    <div className="ord-manager">
      <div className="stat-row" aria-label="趋势策略统计">
        <div className="stat">
          <strong>{armed.length}</strong>
          <span>待命（等触发）</span>
        </div>
        <div className="stat">
          <strong>{active.length}</strong>
          <span>持仓中</span>
        </div>
        <div className="stat">
          <strong>{shadowCount}</strong>
          <span>影子运行中</span>
        </div>
      </div>
      {notice ? (
        <p className="meta" role="status">
          {notice}
        </p>
      ) : null}

      <h2>趋势实例</h2>
      {strategies.length === 0 ? (
        <p className="muted">暂无趋势实例。用下方表单创建：先建影子实例观察事件与模拟轨迹，确认无误后再建实盘实例。</p>
      ) : (
        <ul className="list">
          {strategies.map((strategy) => {
            const cancellable = strategy.status === "armed" || strategy.status === "active";
            return (
              <li key={strategy.id} className="list-item ord-row">
                <div className="ord-main">
                  <div className="list-item-head">
                    <strong>{strategy.symbol}</strong>
                    <span
                      className={
                        strategy.status === "active"
                          ? "badge badge-ok"
                          : strategy.status === "failed"
                            ? "badge badge-bad"
                            : "badge"
                      }
                    >
                      {STATUS_LABELS[strategy.status] ?? strategy.status}
                    </span>
                    <span className="badge badge-accent">{strategy.run_mode === "live" ? "实盘" : "影子"}</span>
                    <span className="badge">{strategy.direction === "long" ? "做多" : "做空"}</span>
                  </div>
                  <p className="meta">
                    {strategy.inst_id} · {strategy.lever}x · 首仓 {strategy.first_sz} 张 · 主题 {strategy.theme} · 止损上限{" "}
                    {strategy.theme_stop_cap_u}U
                  </p>
                  {strategy.status === "active" || strategy.entry_px !== null ? (
                    <p className="meta">
                      {strategy.entry_px !== null ? `均价 ${formatPrice(strategy.entry_px)} · ` : ""}
                      持仓 {strategy.position_sz} 张 · 统一止损 {strategy.stop_px !== null ? formatPrice(strategy.stop_px) : "-"} ·
                      ATR 峰值 {strategy.peak_atr !== null ? formatPrice(strategy.peak_atr) : "-"} · 已加仓 {strategy.adds} 次
                      {strategy.exit_reason ? ` · 退出原因 ${strategy.exit_reason}` : ""}
                    </p>
                  ) : null}
                  {strategy.last_note ? <p className="meta">最近评估：{strategy.last_note}</p> : null}
                  {strategy.recent_events.length > 0 ? (
                    <ul className="meta">
                      {strategy.recent_events.map((event, index) => (
                        <li key={`${event.ts}-${index}`}>
                          {formatDateTime(event.ts)} · {EVENT_LABELS[event.kind] ?? event.kind}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="meta">
                    有效期至 {formatDateTime(strategy.expires_at)}
                    {strategy.note ? ` · ${strategy.note}` : ""}
                  </p>
                </div>
                {cancellable ? (
                  <div className="sym-actions">
                    <button type="button" className="btn-ghost sym-danger" disabled={busy} onClick={() => cancel(strategy)}>
                      取消
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <h2>新建趋势实例（trend_follow）</h2>
      <p className="muted">
        全机械触发：5 分钟 ATR 扩张 + 大实体触发 K 收在方向极值 + Donchian 突破 + 量能与同组确认 + 趋势体制过滤，六闸全过才开仓；持仓后按
        0.5×ATR 步长金字塔加仓，统一止损保证全仓最坏亏损不超过主题上限；ATR 自峰值衰减或收盘反穿 MA60 退出。影子模式只跑状态机与事件，不下单。
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
          账户模式
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="live">实盘账户</option>
            <option value="demo">模拟账户</option>
          </select>
        </label>
        <label>
          运行模式
          <select value={runMode} onChange={(event) => setRunMode(event.target.value)}>
            <option value="shadow">影子（只模拟）</option>
            <option value="live">实盘（真下单）</option>
          </select>
        </label>
        <label>
          方向
          <select value={direction} onChange={(event) => setDirection(event.target.value)}>
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
        </label>
        <label>
          杠杆
          <input type="number" value={lever} onChange={(event) => setLever(event.target.value)} min="1" max="125" step="1" required />
        </label>
        <label>
          首仓张数
          <input type="text" value={firstSz} onChange={(event) => setFirstSz(event.target.value)} placeholder="如 0.01" required />
        </label>
        <label>
          主题 theme
          <input type="text" value={theme} onChange={(event) => setTheme(event.target.value)} placeholder="如 trend-nvda" required />
        </label>
        <label>
          止损上限 (U)
          <input type="number" value={themeStopCapU} onChange={(event) => setThemeStopCapU(event.target.value)} min="0.01" max="0.1" step="0.01" required />
        </label>
        <label>
          有效天数
          <input type="number" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} min="1" max="31" step="1" required />
        </label>
        <label>
          同组确认标的（逗号分隔，可空）
          <input type="text" value={peers} onChange={(event) => setPeers(event.target.value)} placeholder="如 QQQ, MU" />
        </label>
        <label>
          最少同向确认数
          <input type="number" value={peerMinCount} onChange={(event) => setPeerMinCount(event.target.value)} min="0" max="10" step="1" required />
        </label>
        <label>
          ATR 扩张倍数
          <input type="number" value={expansionMultiple} onChange={(event) => setExpansionMultiple(event.target.value)} min="1" max="3" step="0.05" required />
        </label>
        <label>
          量能倍数
          <input type="number" value={volumeMultiple} onChange={(event) => setVolumeMultiple(event.target.value)} min="1" max="5" step="0.1" required />
        </label>
        <label>
          加仓步长（×ATR）
          <input type="number" value={addStepAtr} onChange={(event) => setAddStepAtr(event.target.value)} min="0.1" max="3" step="0.1" required />
        </label>
        <label>
          最多加仓次数
          <input type="number" value={maxAdds} onChange={(event) => setMaxAdds(event.target.value)} min="0" max="10" step="1" required />
        </label>
        <label>
          ATR 衰减退出 %
          <input type="number" value={atrDecayExitPct} onChange={(event) => setAtrDecayExitPct(event.target.value)} min="5" max="90" step="1" required />
        </label>
        <label>
          备注（可空）
          <input type="text" value={note} onChange={(event) => setNote(event.target.value)} placeholder="如 先影子观察一周" />
        </label>
        <button type="submit" className="btn ord-submit" disabled={busy || symbol.trim() === "" || theme.trim() === ""}>
          创建趋势实例
        </button>
      </form>
    </div>
  );
}
