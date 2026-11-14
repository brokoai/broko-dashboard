/**
 * Pure helpers for tests/live/org-memory-supabase.live-dev.script.ts: what cleanup may touch, and when the Claude checks are unambiguous.
 * No network, no environment, no secrets. Unit-tested by tests/org-memory-live-script.test.ts (part of `npm test`).
 */
export interface State { runId: string; ws: string; sources: string[]; held: string[]; docs: { source_id: string; content_hash: string; segments: number }[]; entities: number }

export const RUN_ID_RE = /^\d{14}-[0-9a-f]{6}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * THE ONLY scope cleanup may act on: the workspace "live-test-<runId>" and the three source ids "<runId>-p1..3" derived from that same run id, plus lock ids
 * this run recorded. A state file that does not match exactly (edited, foreign, or from a different naming scheme) is refused outright, so --cleanup can never
 * be pointed at a real workspace or a real source.
 */
export function stateProblems(s: Partial<State>): string[] {
  const out: string[] = [];
  if (typeof s.runId !== "string" || !RUN_ID_RE.test(s.runId)) { out.push("run id is not a live-test run id"); return out; }
  if (s.ws !== `live-test-${s.runId}`) out.push("workspace does not belong to this run");
  const want = [1, 2, 3].map((n) => `${s.runId}-p${n}`);
  if (!Array.isArray(s.sources) || s.sources.length !== 3 || s.sources.some((x, i) => x !== want[i])) out.push("source ids do not belong to this run");
  if (!Array.isArray(s.held) || s.held.some((h) => typeof h !== "string" || !UUID_RE.test(h))) out.push("lock ids are malformed");
  return out;
}

/**
 * K-only runs (--k-only) use their own workspace "live-konly-<runId>" and exactly ONE source id "<runId>-k1". Cleanup for such a run may touch only those; any
 * other shape is refused. (The full run's scope above is unchanged.)
 */
export const KONLY_WS_PREFIX = "live-konly-";
export function kOnlyStateProblems(s: Partial<State>): string[] {
  const out: string[] = [];
  if (typeof s.runId !== "string" || !RUN_ID_RE.test(s.runId)) { out.push("run id is not a live-test run id"); return out; }
  if (s.ws !== `${KONLY_WS_PREFIX}${s.runId}`) out.push("workspace does not belong to this run");
  if (!Array.isArray(s.sources) || s.sources.length !== 1 || s.sources[0] !== `${s.runId}-k1`) out.push("source id does not belong to this run");
  if (!Array.isArray(s.held) || s.held.some((h) => typeof h !== "string" || !UUID_RE.test(h))) out.push("lock ids are malformed");
  return out;
}
/** The scope check cleanup uses: a state is judged by the naming scheme of ITS workspace; anything that matches neither scheme exactly is refused. */
export const cleanupProblems = (s: Partial<State>): string[] => (typeof s.ws === "string" && s.ws.startsWith(KONLY_WS_PREFIX) ? kOnlyStateProblems(s) : stateProblems(s));

export interface Ambiguity { real: number | null; otherSynthetic: number | null }
/** The Claude checks run only when BOTH counts are known and zero. Unknown (null) is treated as not safe. */
export const onlyIfEmpty = (a: Ambiguity): boolean => a.real === 0 && a.otherSynthetic === 0;
export const describeAmbiguity = (a: Ambiguity): string => `active non-synthetic documents=${a.real ?? "unknown"}, active synthetic documents from other runs=${a.otherSynthetic ?? "unknown"}`;

/**
 * The message for a failed sign-in: which variable, the HTTP status and the Supabase error code, nothing else. The provider's free-text message is never
 * used. Both values are re-validated, so an unexpected shape prints "?" instead of anything that could carry an email, key or token.
 */
export function signInFailureMessage(emailKey: string, error: { status?: unknown; code?: unknown }): string {
  const status = typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 0 && error.status < 600 ? String(error.status) : "?";
  const code = typeof error.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "?";
  return `Sign-in failed for ${emailKey}: ${status} ${code}`;
}

/** Sanitized answer diagnostics for a failing Claude check: shape plus a short redacted excerpt, never credentials, urls, emails, ids or long numbers. */
export function sanitizeDiag(text: string, max = 220): string {
  return text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b(?:sk|pk|sb|eyJ)[\w-]{8,}[\w.-]*/g, "<token>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\d{6,}(?:-[0-9a-f]{4,})?/gi, "<num>")
    .replace(/\s+/g, " ").trim().slice(0, max);
}
