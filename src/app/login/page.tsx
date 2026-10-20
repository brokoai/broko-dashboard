import Image from "next/image";
import { redirect } from "next/navigation";
import { DemoLoginForm } from "@/app/login/demo-login-form";
import { LoginForm } from "@/app/login/login-form";
import { company } from "@/config/company";
import { getCurrentUser } from "@/lib/auth";
import { getBackend } from "@/lib/backend";
import { ROLE_LABEL } from "@/lib/types";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const backend = await getBackend();
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-8 sm:py-10">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-card sm:p-8">
        <Image src="/brand/broko-wordmark.jpeg" alt="Broko Realty Ltd" width={1600} height={639} priority className="mx-auto h-auto w-44 mix-blend-multiply" />
        <h1 className="mt-6 text-center text-lg font-semibold text-ink">{company.product}</h1>
        <p className="mb-6 text-center text-sm text-muted">{company.tagline}</p>

        {backend.kind === "demo" && backend.demo ? (
          // Only names and role labels reach the browser.
          <DemoLoginForm
            accounts={backend.demo.accounts.map((u) => ({ id: u.id, name: u.full_name, roleLabel: ROLE_LABEL[u.role] }))}
          />
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
