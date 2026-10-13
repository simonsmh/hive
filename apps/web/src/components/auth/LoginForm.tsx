"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/src/modules/auth/actions";

const initialState: LoginState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="login-form">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="password">访问密码</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
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
