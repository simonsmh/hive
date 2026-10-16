"use client";

import { useStreamStatus } from "@/src/modules/live/stream-client";

/** Global stream indicator for the topbar and the sidebar. */
export function LiveStatus() {
  const status = useStreamStatus();
  const label = status === "live" ? "实时" : status === "connecting" ? "连接中" : "重连中";
  return (
    <span className={`live-status live-${status}`} role="status" aria-label={`数据流状态：${label}`}>
      <span className="live-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
