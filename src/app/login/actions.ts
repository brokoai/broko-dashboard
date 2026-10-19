"use server";

import { redirect } from "next/navigation";
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

export async function signInAsDemo(form: FormData) {
  const demo = (await getBackend()).demo; // undefined unless demo mode is on
  if (!demo || !(await demo.signInAs(String(form.get("user") ?? "")))) redirect("/login");
  redirect("/");
}

export async function signOut() {
  await (await getBackend()).signOut();
  redirect("/login");
}
