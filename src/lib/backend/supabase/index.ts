import "server-only";
import type { Backend } from "../types";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "./profile";
import { createSupabaseRepo } from "./repo";
import { createClient } from "./server";

export const supabaseBackend: Backend = {
  kind: "supabase",
  async getCurrentUser() {
    const db = await createClient();
    const { data } = await db.auth.getUser(); // validates the JWT with Supabase
    if (!data.user) return null;
    const { data: profile } = await db
      .from("profiles").select(PROFILE_COLUMNS).eq("id", data.user.id).maybeSingle();
    // The email is the verified one from the auth session, not a column read from the shared profiles table.
    return profile ? toProfile(profile as ProfileRow, data.user.email) : null;
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
