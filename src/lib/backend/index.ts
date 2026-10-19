import "server-only";
import { demoMode, supabaseConfigured } from "@/lib/env";
import type { Backend } from "./types";

/**
 * Unconfigured: nobody can sign in. This is the safe default (and what a production
 * build without credentials, or with only partial credentials, gets).
 */
const unconfiguredBackend: Backend = {
  kind: "unconfigured",
  async getCurrentUser() { return null; },
  async signInWithPassword() { return { error: "Sign-in is not configured." }; },
  async signOut() {},
  async repoFor() { throw new Error("No backend is configured."); },
};

/**
 * Selects the backend. Real credentials always win: if Supabase is usable it is the only
 * option, and demo mode is impossible whenever any Supabase credential is present (see
 * resolveDemoConfig). To add AWS (or anything else), implement `Backend` in
 * src/lib/backend/<name>/ and return it here. Implementations are imported lazily so
 * demo code is never loaded unless demo mode is explicitly enabled.
 */
export async function getBackend(): Promise<Backend> {
  if (supabaseConfigured()) return (await import("./supabase")).supabaseBackend;
  if (demoMode()) return (await import("./demo")).demoBackend;
  return unconfiguredBackend;
}
