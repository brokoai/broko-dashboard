import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getBackend } from "@/lib/backend";
import type { Repo } from "@/lib/backend/types";
import type { Profile } from "@/lib/types";

/** Current signed-in profile, or null. The backend validates the session server-side. */
export const getCurrentUser = cache(async (): Promise<Profile | null> => {
  // Always read cookies first: this opts every caller into dynamic rendering, so a
  // "not signed in" result can never be prerendered and cached for all users.
  await cookies();
  return (await getBackend()).getCurrentUser();
});

export async function requireUser(): Promise<Profile> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<Profile> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}

/** Data access scoped to the signed-in user. */
export async function getRepo(user: Profile): Promise<Repo> {
  return (await getBackend()).repoFor(user);
}
