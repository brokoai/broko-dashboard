import type { Profile, Role } from "@/lib/types";

/**
 * The columns the dashboard reads from `profiles` for the signed-in user. Deliberately WITHOUT `email`: a user's own
 * email comes from their auth session, so the database can stop exposing colleagues' emails (finding M-4, see
 * docs/SUPABASE_SECURITY_STATUS.md and supabase/proposed/0006_profiles_privacy.proposed.sql).
 */
export const PROFILE_COLUMNS = "id, full_name, role, title";

export interface ProfileRow { id: string; full_name: string; role: Role; title: string | null }

/** Builds the dashboard's Profile from the profiles row and the verified auth session (never from another user's row). */
export const toProfile = (row: ProfileRow, authEmail: string | null | undefined): Profile => ({
  id: row.id, full_name: row.full_name, role: row.role, title: row.title, email: authEmail ?? null,
});
