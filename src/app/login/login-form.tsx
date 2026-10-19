"use client";

import { useActionState } from "react";
import { signInWithPassword, type LoginState } from "@/app/login/actions";
import { btn, cx } from "@/components/ui";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(signInWithPassword, {});
  const field = "mt-1 w-full rounded-md border border-line px-3 py-2 text-sm";
  return (
    <form action={action} className="space-y-4">
      {state.error && <p role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-sm text-brand-dark">{state.error}</p>}
      <div><label htmlFor="email" className="text-sm font-medium">Email</label><input id="email" name="email" type="email" autoComplete="email" required className={field} /></div>
      <div><label htmlFor="password" className="text-sm font-medium">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required className={field} /></div>
      <button type="submit" disabled={pending} className={cx(btn.base, btn.primary, "w-full")}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
