import type { Metadata } from "next";
import { LoginForm } from "@/src/components/auth/LoginForm";
import { safeNextPath } from "@/src/modules/auth/session";

export const metadata: Metadata = { title: "登录" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = safeNextPath(Array.isArray(next) ? next[0] : next);

  return (
    <main className="login">
      <section className="login-card">
        <h1>Hive</h1>
        <p className="muted">市场数据看板，请输入访问密码。</p>
        <LoginForm next={target} />
      </section>
    </main>
  );
}
