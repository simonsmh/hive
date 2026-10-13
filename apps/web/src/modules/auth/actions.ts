"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkDashboardPassword, createSessionToken, isUsableSecret, safeNextPath, sessionCookieAttributes } from "./session";

export interface LoginState {
  error: string | null;
}

const FAILED_LOGIN_DELAY_MS = 500;

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const expectedPassword = process.env.HIVE_DASHBOARD_PASSWORD;
  const sessionSecret = process.env.HIVE_SESSION_SECRET;
  if (!expectedPassword || !isUsableSecret(sessionSecret)) {
    console.error("[auth] HIVE_DASHBOARD_PASSWORD or HIVE_SESSION_SECRET is not configured");
    return { error: "服务器未配置登录参数" };
  }

  const password = formData.get("password");
  const passwordOk = typeof password === "string" && (await checkDashboardPassword(password, expectedPassword));
  if (!passwordOk) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return { error: "密码错误" };
  }

  const token = await createSessionToken(sessionSecret);
  (await cookies()).set({ ...sessionCookieAttributes(), value: token });
  redirect(safeNextPath(formData.get("next")));
}

export async function logoutAction(): Promise<void> {
  (await cookies()).set({ ...sessionCookieAttributes(0), value: "" });
  redirect("/login");
}
