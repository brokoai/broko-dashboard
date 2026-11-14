import { sanitizeDiag } from "./org-memory-live-plan";

/**
 * Pure helpers for the READ-ONLY relationship smoke test (tests/live/org-relationships-readonly.live-dev.script.ts). No network here.
 * PostgREST error CODES (PGRST200 ...) and messages about the SCHEMA ("Could not find a relationship between ...") carry no row data, but the message is
 * still passed through sanitizeDiag and truncated, so a stray email, token or long number can never reach the output.
 */

export interface PgErr { status?: number; code?: string; message?: string }
export interface Probe { id: string; title: string; ok: boolean; detail: string }

export function describeErr(e: PgErr | null | undefined): string {
  if (!e) return "no error";
  const code = typeof e.code === "string" && /^[A-Za-z0-9_]{1,12}$/.test(e.code) ? e.code : "?";
  const status = typeof e.status === "number" && e.status >= 100 && e.status < 600 ? String(e.status) : "?";
  return `${status} ${code}: ${sanitizeDiag(String(e.message ?? ""), 140)}`;
}

/** What each failure code means for the schema cache, so a failure is actionable. */
export function schemaHint(e: PgErr | null | undefined): string | null {
  switch (e?.code) {
    case "PGRST200": return "embed relationship not found in the schema cache (wrong FK hint, or the cache has not picked up 0014)";
    case "PGRST201": return "embed is ambiguous: more than one foreign key path (a hint is required)";
    case "PGRST205": return "table not found in the schema cache (reload the cache, or the table is not exposed)";
    case "PGRST202": return "function not found in the schema cache (signature mismatch, or the cache is stale)";
    case "42501": return "permission denied (expected for anon and for a non-administrator calling a function)";
    default: return null;
  }
}

/** A read that must succeed and return an empty set (the relationship tables hold no rows yet). */
export function expectEmpty(res: { data: unknown; error: PgErr | null }): { ok: boolean; detail: string } {
  if (res.error) return { ok: false, detail: describeErr(res.error) };
  if (!Array.isArray(res.data)) return { ok: false, detail: "response was not a list" };
  return res.data.length === 0 ? { ok: true, detail: "200, empty list" } : { ok: false, detail: `200, but ${res.data.length} row(s): the table is not empty, so empty-result checks do not apply (counts only, no row data shown)` };
}

/** A read that must be refused (permission denied) or return nothing: used for anon and for a member. */
export function expectNoAccess(res: { data: unknown; error: PgErr | null; status?: number }): { ok: boolean; detail: string } {
  if (res.error) return { ok: res.error.code === "42501" || res.status === 401 || res.status === 403, detail: describeErr({ status: res.status, ...res.error }) };
  return Array.isArray(res.data) && res.data.length === 0 ? { ok: true, detail: "200, empty list (row level security, or no rows)" } : { ok: false, detail: "returned rows" };
}
