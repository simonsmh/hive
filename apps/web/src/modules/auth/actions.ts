"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  checkApiToken,
  checkDashboardPassword,
  createSessionToken,
  isUsableSecret,
  safeNextPath,
  sessionCookieAttributes,
} from "./session";

export interface LoginState {
  error: string | null;
}

const FAILED_LOGIN_DELAY_MS = 500;

/**
 * Two credentials open the same session: the dashboard password, or the API token
 * (HIVE_API_TOKEN) that already guards /api/*. Token holders — people and agents the
 * gateway is shared with — can use the UI without being given the password.
 * The failure message is identical either way so the form is not a credential oracle.
 */
export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const sessionSecret = process.env.HIVE_SESSION_SECRET;
  if (!isUsableSecret(sessionSecret)) {
    console.error("[auth] HIVE_SESSION_SECRET is not configured");
    return { error: "服务器未配置登录参数" };
  }

  const token = formData.get("token");
  const password = formData.get("password");
  let credentialOk = false;
  if (typeof token === "string" && token.length > 0) {
    const expectedToken = process.env.HIVE_API_TOKEN;
    if (!expectedToken) {
      console.error("[auth] HIVE_API_TOKEN is not configured");
      return { error: "服务器未配置 Token 登录" };
    }
    credentialOk = await checkApiToken(token, expectedToken);
  } else {
    const expectedPassword = process.env.HIVE_DASHBOARD_PASSWORD;
    if (!expectedPassword) {
      console.error("[auth] HIVE_DASHBOARD_PASSWORD is not configured");
      return { error: "服务器未配置登录参数" };
    }
    credentialOk = typeof password === "string" && (await checkDashboardPassword(password, expectedPassword));
  }

  if (!credentialOk) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return { error: "凭据不正确" };
  }

  const session = await createSessionToken(sessionSecret);
  (await cookies()).set({ ...sessionCookieAttributes(), value: session });
  redirect(safeNextPath(formData.get("next")));
}

export async function logoutAction(): Promise<void> {
  (await cookies()).set({ ...sessionCookieAttributes(0), value: "" });
  redirect("/login");
}
