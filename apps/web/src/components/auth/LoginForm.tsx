"use client";

import { useActionState, useState } from "react";
import { loginAction, type LoginState } from "@/src/modules/auth/actions";

const initialState: LoginState = { error: null };

type Mode = "password" | "token";

/** Password login for the operator; token login for everyone the gateway is shared with. */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [mode, setMode] = useState<Mode>("password");

  return (
    <form action={formAction} className="login-form">
      <input type="hidden" name="next" value={next} />
      <div className="segmented" role="tablist" aria-label="登录方式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "password"}
          className="segmented-item"
          onClick={() => setMode("password")}
        >
          访问密码
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "token"}
          className="segmented-item"
          onClick={() => setMode("token")}
        >
          API Token
        </button>
      </div>
      {mode === "password" ? (
        <>
          <label htmlFor="password">访问密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
        </>
      ) : (
        <>
          <label htmlFor="token">API Token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            required
            autoFocus
            placeholder="粘贴 HIVE_API_TOKEN"
          />
          <p className="muted">用调用 /api 接口的 Bearer Token 登录，登录后权限与密码登录相同。</p>
        </>
      )}
      {state.error ? (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
