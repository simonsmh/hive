import type { ReactNode } from "react";

export const metadata = {
  title: "Hive API",
  description: "Hive 市场数据读取 API",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem", lineHeight: 1.6 }}>{children}</body>
    </html>
  );
}
