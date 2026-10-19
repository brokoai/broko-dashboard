import "server-only";
import type { Profile } from "@/lib/types";
import type { Backend } from "../types";
import { createSupabaseRepo } from "./repo";
import { createClient } from "./server";

export const supabaseBackend: Backend = {
  kind: "supabase",
  async getCurrentUser() {
    const db = await createClient();
    const { data } = await db.auth.getUser(); // validates the JWT with Supabase
    if (!data.user) return null;
    const { data: profile } = await db
      .from("profiles").select("id, full_name, email, role, title").eq("id", data.user.id).maybeSingle();
    return (profile as Profile | null) ?? null;
  },
  async signInWithPassword(email, password) {
    const { error } = await (await createClient()).auth.signInWithPassword({ email, password });
    return error ? { error: "Invalid email or password." } : {};
  },
  async signOut() {
    await (await createClient()).auth.signOut();
  },
  async repoFor(user) {
    return createSupabaseRepo(await createClient(), user.id);
  },
};
