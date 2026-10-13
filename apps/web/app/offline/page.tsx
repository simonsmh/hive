import type { Metadata } from "next";

export const metadata: Metadata = { title: "离线" };

// Static and data-free on purpose: the service worker precaches this page for offline use.
export default function OfflinePage() {
  return (
    <main className="offline">
      <h1>当前离线</h1>
      <p>无法连接 Hive 服务器。恢复网络后重新连接，即可查看最新数据。</p>
      <a className="btn" href="/">
        重新连接
      </a>
    </main>
  );
}
