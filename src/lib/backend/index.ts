import "server-only";
import { demoMode, supabaseConfigured } from "@/lib/env";
import type { Backend } from "./types";

/**
 * Unconfigured: nobody can sign in. This is the safe default (and what a production
 * build without credentials gets).
 */
const unconfiguredBackend: Backend = {
  kind: "unconfigured",
  async getCurrentUser() { return null; },
  async signInWithPassword() { return { error: "Sign-in is not configured." }; },
  async signOut() {},
  async repoFor() { throw new Error("No backend is configured."); },
};

/**
 * Selects the backend. To add AWS (or anything else), implement `Backend` in
 * src/lib/backend/<name>/ and return it here. Implementations are imported lazily so
 * demo code is never loaded unless demo mode is explicitly on (and never in production).
 */
export async function getBackend(): Promise<Backend> {
  if (supabaseConfigured()) return (await import("./supabase")).supabaseBackend;
  if (demoMode()) return (await import("./demo")).demoBackend;
  return unconfiguredBackend;
}
