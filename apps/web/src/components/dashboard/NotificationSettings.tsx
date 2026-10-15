"use client";

import { useEffect, useState } from "react";
import {
  currentSubscription,
  pushSupport,
  subscribePush,
  unsubscribePush,
  updatePushFilters,
  type PushFilters,
  type PushSupport,
} from "@/src/modules/pwa/push-client";

type Phase = "loading" | "unsubscribed" | "subscribed" | "denied" | "working";

const FILTER_STORAGE_KEY = "hive-push-filters";

function loadFilters(): PushFilters {
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PushFilters>;
      return { news: parsed.news !== false, alerts: parsed.alerts !== false };
    }
  } catch {
    // Fall through to defaults.
  }
  return { news: true, alerts: true };
}

/**
 * Push notification controls for the settings panel. The subscription lives in the
 * browser; the server keeps the endpoint and the owner's filter choices so the
 * per-minute push-notify run can fan out news and critical alerts.
 */
export function NotificationSettings({ publicKey }: { publicKey: string | null }) {
  // Browser capability detection must wait for hydration: the server render has no
  // window, so evaluating pushSupport() during render would emit unsupported
  // markup that mismatches the client's first render. Start browser-neutral.
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [filters, setFilters] = useState<PushFilters>({ news: true, alerts: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupport(pushSupport(publicKey));
  }, [publicKey]);

  useEffect(() => {
    if (support !== "ready") return;
    setFilters(loadFilters());
    if (Notification.permission === "denied") {
      setPhase("denied");
      return;
    }
    currentSubscription()
      .then((subscription) => setPhase(subscription ? "subscribed" : "unsubscribed"))
      .catch(() => setPhase("unsubscribed"));
  }, [support]);

  if (support === null) {
    return <p className="meta">正在检测推送支持…</p>;
  }

  if (support === "no-vapid-key") {
    return (
      <div className="empty">
        <strong>推送未配置</strong>
        服务器尚未设置 VAPID 密钥（NEXT_PUBLIC_VAPID_PUBLIC_KEY），配置后这里可以开启新闻与告警推送。
      </div>
    );
  }
  if (support === "unsupported") {
    return (
      <div className="empty">
        <strong>当前浏览器不支持推送</strong>
        请使用支持 Web Push 的浏览器；iPhone 需要先把 Hive 添加到主屏幕再开启。
      </div>
    );
  }

  const applyFilters = (next: PushFilters) => {
    setFilters(next);
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage may be unavailable; the server copy is what matters.
    }
    if (phase === "subscribed") {
      updatePushFilters(next).catch(() => setError("筛选已保存在本机，但同步到服务器失败。"));
    }
  };

  const subscribe = async () => {
    setPhase("working");
    setError(null);
    try {
      await subscribePush(publicKey!, filters);
      setPhase("subscribed");
    } catch (cause) {
      if (cause instanceof Error && cause.message === "permission-not-granted") {
        setPhase(Notification.permission === "denied" ? "denied" : "unsubscribed");
        setError("没有获得通知权限。");
      } else {
        setPhase("unsubscribed");
        setError("订阅失败，请稍后重试。");
      }
    }
  };

  const unsubscribe = async () => {
    setPhase("working");
    setError(null);
    try {
      await unsubscribePush();
      setPhase("unsubscribed");
    } catch {
      setPhase("subscribed");
      setError("取消订阅失败，请稍后重试。");
    }
  };

  return (
    <div>
      <div className="toggle-rows">
        <label className="toggle-row">
          <span>
            <strong>新闻推送</strong>
            <span className="muted">新新闻事件到达时通知</span>
          </span>
          <input
            type="checkbox"
            checked={filters.news}
            onChange={(event) => applyFilters({ ...filters, news: event.target.checked })}
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>重要告警推送</strong>
            <span className="muted">critical 告警与数据源过期时通知</span>
          </span>
          <input
            type="checkbox"
            checked={filters.alerts}
            onChange={(event) => applyFilters({ ...filters, alerts: event.target.checked })}
          />
        </label>
      </div>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      {phase === "denied" ? (
        <p className="meta">通知权限已被浏览器拒绝，需要在浏览器网站设置里手动允许后才能订阅。</p>
      ) : phase === "subscribed" ? (
        <>
          <p className="meta">
            <span className="badge badge-ok">已订阅</span> 本设备会收到上面勾选类别的推送。
          </p>
          <button type="button" className="btn-ghost" onClick={unsubscribe}>
            取消订阅
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={subscribe} disabled={phase === "loading" || phase === "working"}>
          {phase === "working" ? "处理中…" : "在本设备开启推送"}
        </button>
      )}
    </div>
  );
}
