import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardNav } from "@/src/components/dashboard/DashboardNav";
import { InstallPrompt } from "@/src/components/pwa/InstallPrompt";
import { logoutAction } from "@/src/modules/auth/actions";
import { SESSION_COOKIE, verifySessionToken } from "@/src/modules/auth/session";
import { getNavItems } from "@/src/modules/registry";

// Middleware is the primary gate; this repeats the check so the panels never render without a session.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token, process.env.HIVE_SESSION_SECRET))) {
    redirect("/login");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">Hive</span>
        <form action={logoutAction}>
          <button type="submit" className="btn-ghost">
            退出
          </button>
        </form>
      </header>
      <div className="content">{children}</div>
      <DashboardNav items={getNavItems()} />
      <InstallPrompt />
    </div>
  );
}
