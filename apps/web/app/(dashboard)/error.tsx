"use client";
export default function DashboardError({ reset }: { reset: () => void }) {
  return <section className="panel"><div className="error" role="alert">模块暂时无法加载，未确认数据更新。其他模块仍可通过导航打开。</div><button className="btn-ghost" onClick={reset}>重试当前模块</button></section>;
}
