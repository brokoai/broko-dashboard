import type { Profile } from "@/lib/types";

// Pre-Construction access rules. The database enforces the same rules independently (supabase/proposed/0007): everyone signed in
// reads active projects; only administrators write; only administrators see unit numbers.

export const canManagePrecon = (u: Profile): boolean => u.role === "admin";
export const canSeeUnitNumbers = (u: Profile): boolean => u.role === "admin";
