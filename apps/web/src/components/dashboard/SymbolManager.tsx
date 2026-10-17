"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { UniverseEntry } from "@hive/core";
import type { SymbolView } from "@/src/modules/symbols/mapper";
import { formatPrice, formatSignedPercent } from "@/src/modules/format";

/** Rough steady-state footprint per tracked symbol: 30 days of 1m/5m/15m bars plus permanent 1D. */
const MB_PER_SYMBOL = 12;
const DB_BUDGET_MB = 500;

interface AddResult {
  symbol: string;
  action: "created" | "updated";
  okx_resolved: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; problems?: string[] };
  if (!response.ok) {
    throw new Error(body.problems?.join("；") ?? body.error ?? `请求失败 (${response.status})`);
  }
  return body;
}

function formatTurnover(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function SymbolManager({ initialSymbols }: { initialSymbols: SymbolView[] }) {
  const [symbols, setSymbols] = useState<SymbolView[]>(initialSymbols);
  const [universe, setUniverse] = useState<UniverseEntry[] | null>(null);
  const [universeError, setUniverseError] = useState<string | null>(null);
  const [selectedTracked, setSelectedTracked] = useState<ReadonlySet<string>>(new Set());
  const [selectedUniverse, setSelectedUniverse] = useState<ReadonlySet<string>>(new Set());
  const [universeFilter, setUniverseFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualSymbol, setManualSymbol] = useState("");
  const [manualThsCode, setManualThsCode] = useState("");

  const refreshSymbols = useCallback(async () => {
    const data = await api<{ symbols: SymbolView[] }>("/api/symbols");
    setSymbols(data.symbols);
    setSelectedTracked(new Set());
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ universe: UniverseEntry[] }>("/api/universe")
      .then((data) => {
        if (!cancelled) setUniverse(data.universe);
      })
      .catch((error: Error) => {
        if (!cancelled) setUniverseError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trackedInstIds = useMemo(
    () => new Set(symbols.map((row) => row.okx_inst_id).filter((value): value is string => value !== null)),
    [symbols],
  );
  const enabledCount = symbols.filter((row) => row.enabled).length;

  const run = useCallback(
    async (label: string, action: () => Promise<string>) => {
      setBusy(label);
      setNotice(null);
      try {
        const message = await action();
        await refreshSymbols();
        setNotice(message);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "操作失败");
      } finally {
        setBusy(null);
      }
    },
    [refreshSymbols],
  );

  const addSymbols = useCallback(
    (entries: { symbol: string; okx_inst_id?: string; ths_code?: string }[], label: string) =>
      run(label, async () => {
        const data = await api<{ results: AddResult[] }>("/api/symbols", {
          method: "POST",
          body: JSON.stringify({ symbols: entries }),
        });
        setSelectedUniverse(new Set());
        const unresolved = data.results.filter((result) => !result.okx_resolved && !entries.find((e) => e.symbol === result.symbol)?.ths_code);
        return unresolved.length > 0
          ? `已添加 ${data.results.length} 个；${unresolved.map((r) => r.symbol).join("、")} 在 OKX 查无永续，仅建档未采集`
          : `已添加 ${data.results.length} 个标的，下一分钟内开始采集`;
      }),
    [run],
  );

  const removeSymbols = useCallback(
    (targets: string[]) => {
      if (!window.confirm(`确认删除 ${targets.join("、")}？历史 K 线会保留并按保留策略自然过期。`)) return;
      void run("remove", async () => {
        const data = await api<{ removed: string[] }>("/api/symbols/remove", {
          method: "POST",
          body: JSON.stringify({ symbols: targets }),
        });
        return `已删除 ${data.removed.length} 个标的`;
      });
    },
    [run],
  );

  const setEnabled = useCallback(
    (targets: string[], enabled: boolean) =>
      run(enabled ? "enable" : "disable", async () => {
        await api("/api/symbols", {
          method: "PATCH",
          body: JSON.stringify({ symbols: targets, enabled }),
        });
        return `已${enabled ? "启用" : "停用"} ${targets.length} 个标的`;
      }),
    [run],
  );

  const toggle = (set: ReadonlySet<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const visibleUniverse = useMemo(() => {
    if (!universe) return [];
    const needle = universeFilter.trim().toUpperCase();
    return needle ? universe.filter((entry) => entry.symbol.includes(needle) || entry.instId.includes(needle)) : universe;
  }, [universe, universeFilter]);

  return (
    <div className="sym-manager">
      <div className="stat-row" aria-label="标的统计">
        <div className="stat">
          <strong>{symbols.length}</strong>
          <span>已跟踪</span>
        </div>
        <div className="stat">
          <strong>{enabledCount}</strong>
          <span>启用中</span>
        </div>
        <div className="stat">
          <strong>
            ≈{enabledCount * MB_PER_SYMBOL}MB<span className="muted"> / {DB_BUDGET_MB}MB</span>
          </strong>
          <span>稳态占用预估</span>
        </div>
      </div>
      {notice ? (
        <p className="meta" role="status">
          {notice}
        </p>
      ) : null}

      <h2>已跟踪标的</h2>
      {selectedTracked.size > 0 ? (
        <div className="sym-toolbar" role="group" aria-label="批量操作">
          <span>已选 {selectedTracked.size} 个</span>
          <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => setEnabled([...selectedTracked], true)}>
            批量启用
          </button>
          <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => setEnabled([...selectedTracked], false)}>
            批量停用
          </button>
          <button type="button" className="btn-ghost sym-danger" disabled={busy !== null} onClick={() => removeSymbols([...selectedTracked])}>
            批量删除
          </button>
        </div>
      ) : null}
      {symbols.length === 0 ? (
        <p className="muted">暂无标的。从下方排行添加，或手动输入代码添加。</p>
      ) : (
        <ul className="list sym-list">
          {symbols.map((row) => (
            <li key={row.symbol} className="list-item sym-row">
              <label className="sym-check">
                <input
                  type="checkbox"
                  checked={selectedTracked.has(row.symbol)}
                  onChange={() => toggle(selectedTracked, row.symbol, setSelectedTracked)}
                  aria-label={`选择 ${row.symbol}`}
                />
              </label>
              <div className="sym-main">
                <div className="list-item-head">
                  <strong>{row.symbol}</strong>
                  <span className={row.enabled ? "badge badge-ok" : "badge"}>{row.enabled ? "启用" : "停用"}</span>
                  {row.sources.map((source) => (
                    <span key={source} className="badge badge-accent">
                      {source}
                    </span>
                  ))}
                </div>
                <p className="meta">
                  {[row.okx_inst_id, row.yahoo_symbol ? `Yahoo ${row.yahoo_symbol}` : null, row.ths_code ? `THS ${row.ths_code}` : null]
                    .filter(Boolean)
                    .join(" · ") || "无采集映射"}
                </p>
              </div>
              <div className="sym-actions">
                <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => setEnabled([row.symbol], !row.enabled)}>
                  {row.enabled ? "停用" : "启用"}
                </button>
                <button type="button" className="btn-ghost sym-danger" disabled={busy !== null} onClick={() => removeSymbols([row.symbol])}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>OKX 成交额排行（24h · 前 100）</h2>
      <p className="muted">按成交额（成交量 × 最新价）排序。点「添加」即开始采集；已跟踪的会标注。</p>
      <div className="sym-toolbar">
        <input
          type="search"
          value={universeFilter}
          onChange={(event) => setUniverseFilter(event.target.value)}
          placeholder="筛选代码，如 SOL"
          aria-label="筛选排行"
        />
        {selectedUniverse.size > 0 ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              addSymbols(
                visibleUniverse
                  .filter((entry) => selectedUniverse.has(entry.instId))
                  .map((entry) => ({ symbol: entry.symbol, okx_inst_id: entry.instId })),
                "batch-add",
              )
            }
          >
            批量添加 {selectedUniverse.size} 个
          </button>
        ) : null}
      </div>
      {universeError ? (
        <p className="error" role="alert">
          排行加载失败：{universeError}
        </p>
      ) : universe === null ? (
        <p className="muted">排行加载中…</p>
      ) : (
        <ul className="list sym-list">
          {visibleUniverse.map((entry) => {
            const tracked = trackedInstIds.has(entry.instId);
            return (
              <li key={entry.instId} className="list-item sym-row">
                {tracked ? (
                  <span className="sym-rank">{entry.rank}</span>
                ) : (
                  <label className="sym-check">
                    <input
                      type="checkbox"
                      checked={selectedUniverse.has(entry.instId)}
                      onChange={() => toggle(selectedUniverse, entry.instId, setSelectedUniverse)}
                      aria-label={`选择 ${entry.symbol}`}
                    />
                    <span className="sym-rank">{entry.rank}</span>
                  </label>
                )}
                <div className="sym-main">
                  <div className="list-item-head">
                    <strong>{entry.symbol}</strong>
                    <span className="meta">{entry.instId}</span>
                    {tracked ? <span className="badge badge-ok">已跟踪</span> : null}
                  </div>
                  <p className="meta">
                    最新 {formatPrice(entry.last)} · 成交额 {formatTurnover(entry.turnover)}
                    {entry.change24h !== null ? (
                      <>
                        {" · 24h "}
                        <span className={entry.change24h >= 0 ? "sym-up" : "sym-down"}>
                          {formatSignedPercent(entry.change24h * 100)}
                        </span>
                      </>
                    ) : null}
                  </p>
                </div>
                {tracked ? null : (
                  <div className="sym-actions">
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy !== null}
                      onClick={() => addSymbols([{ symbol: entry.symbol, okx_inst_id: entry.instId }], `add-${entry.instId}`)}
                    >
                      添加
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2>手动添加</h2>
      <p className="muted">输入标的代码即可：有 OKX 永续的会自动匹配合约与 Yahoo 代码；A 股请同时填同花顺代码（如 600519.SH）。</p>
      <form
        className="sym-manual"
        onSubmit={(event) => {
          event.preventDefault();
          const symbol = manualSymbol.trim().toUpperCase();
          if (!symbol) return;
          const thsCode = manualThsCode.trim().toUpperCase();
          void addSymbols([{ symbol, ...(thsCode ? { ths_code: thsCode } : {}) }], "manual-add").then(() => {
            setManualSymbol("");
            setManualThsCode("");
          });
        }}
      >
        <input
          type="text"
          value={manualSymbol}
          onChange={(event) => setManualSymbol(event.target.value)}
          placeholder="代码，如 SOL / MOUTAI"
          aria-label="标的代码"
          required
        />
        <input
          type="text"
          value={manualThsCode}
          onChange={(event) => setManualThsCode(event.target.value)}
          placeholder="同花顺代码（可选），如 600519.SH"
          aria-label="同花顺代码"
        />
        <button type="submit" className="btn" disabled={busy !== null || manualSymbol.trim() === ""}>
          添加
        </button>
      </form>
    </div>
  );
}
