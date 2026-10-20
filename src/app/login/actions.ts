"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getBackend } from "@/lib/backend";

export interface LoginState { error?: string }

export async function signInWithPassword(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  const { error } = await (await getBackend()).signInWithPassword(email, password);
  if (error) return { error };
  redirect("/");
}

/** Demo entry point: open sign-in as a placeholder account (synthetic data only, no password). */
export async function signInAsDemo(_prev: LoginState, form: FormData): Promise<LoginState> {
  const demo = (await getBackend()).demo; // undefined unless demo mode is enabled
  if (!demo) redirect("/login");
  const { error } = await demo.signInAs(String(form.get("user") ?? ""));
  if (error) return { error };
  redirect("/");
}

/** Clears only the signed-in visitor's own demo changes. */
export async function resetDemo() {
  await requireUser();
  await (await getBackend()).demo?.reset();
  revalidatePath("/", "layout"); // the redirect target is usually the current page; drop its cached view
  redirect("/");
}

export async function signOut() {
  await (await getBackend()).signOut();
  redirect("/login");
}
