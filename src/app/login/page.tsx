import Image from "next/image";
import { redirect } from "next/navigation";
import { LoginForm } from "@/app/login/login-form";
import { signInAsDemo } from "@/app/login/actions";
import { btn, cx } from "@/components/ui";
import { company } from "@/config/company";
import { getCurrentUser } from "@/lib/auth";
import { getBackend } from "@/lib/backend";
import { ROLE_LABEL } from "@/lib/types";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const backend = await getBackend();
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-8 shadow-card">
        <Image src="/brand/broko-wordmark.jpeg" alt="Broko Realty Ltd" width={1600} height={639} priority className="mx-auto h-auto w-44 mix-blend-multiply" />
        <h1 className="mt-6 text-center text-lg font-semibold text-ink">{company.product}</h1>
        <p className="mb-6 text-center text-sm text-muted">{company.tagline}</p>

        {backend.kind === "demo" && backend.demo ? (
          <form action={signInAsDemo} className="space-y-2">
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">Demo mode: no real backend is connected. These are placeholder accounts with in-memory data.</p>
            {backend.demo.accounts.map((u) => (
              <button key={u.id} name="user" value={u.id} className={cx(btn.base, btn.secondary, "w-full justify-between")}>
                <span>{u.full_name}</span><span className="text-xs text-muted">{ROLE_LABEL[u.role]}</span>
              </button>
            ))}
          </form>
        ) : backend.kind === "unconfigured" ? (
          <p role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-sm text-brand-dark">
            Sign-in is not configured. Ask your administrator to connect the backend (see .env.example).
          </p>
        ) : (
          <LoginForm />
        )}
      </div>
    </div>
  );
}
