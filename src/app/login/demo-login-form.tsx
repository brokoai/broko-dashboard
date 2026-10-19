"use client";

import { useActionState } from "react";
import { signInAsDemo, type LoginState } from "@/app/login/actions";
import { btn, cx } from "@/components/ui";

export interface DemoAccount { id: string; name: string; roleLabel: string }

export function DemoLoginForm({ accounts, codeRequired }: { accounts: DemoAccount[]; codeRequired: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(signInAsDemo, {});
  return (
    <form action={action} className="space-y-2">
      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
        Demo mode: no real backend is connected. These are placeholder accounts with synthetic sample data only. Changes are temporary: kept in this browser for up to 24 hours, then discarded.
      </p>
      {state.error && <p role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-sm text-brand-dark">{state.error}</p>}
      {codeRequired && (
        <div>
          <label htmlFor="demo-code" className="text-sm font-medium">Demo access code</label>
          <input id="demo-code" name="code" type="password" autoComplete="off" required className="mt-1 mb-1 w-full rounded-md border border-line px-3 py-2 text-sm" />
        </div>
      )}
      {accounts.map((a) => (
        <button key={a.id} name="user" value={a.id} disabled={pending} className={cx(btn.base, btn.secondary, "w-full justify-between")}>
          <span>{a.name}</span><span className="text-xs text-muted">{a.roleLabel}</span>
        </button>
      ))}
    </form>
  );
}
