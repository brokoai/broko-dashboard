/**
 * Pure helpers for tests/live/knowledge-live-dev.script.ts: the test plan, the run marker, the target guard and the purge-SQL printer.
 * No network, no environment reads, no secrets. Unit-tested by tests/knowledge-live-script.test.ts (part of `npm test`).
 */

export const DEV_REF = "olngcbgkxbceqpikcyxk";

export type Role = "none" | "admin" | "member" | "anon" | "admin+member" | "member+admin" | "member+anon";
export interface Step { id: string; group: "A" | "B" | "C" | "D" | "E" | "F" | "G"; role: Role; writes: boolean; text: string }

/** Every assertion the live script can report. The script refuses to report an id that is not listed here, and lists any id it never reached as NOT RUN. */
export const PLAN: readonly Step[] = [
  // A. target and preconditions (nothing is written; A5 only ATTEMPTS inserts that must be refused by design)
  { id: "A1", group: "A", role: "none", writes: false, text: "URL host is exactly the broko-dev ref, PRECON_LIVE_CONFIRM=broko-dev, the local linked project is that ref, and the key is not a secret/service-role key" },
  { id: "A2", group: "A", role: "admin+member", writes: false, text: "separate admin and member sessions sign in; profile roles are admin and member; they are different users" },
  { id: "A6", group: "A", role: "admin", writes: false, text: "presence check (read-only count, no profile details): no accounts other than the two test accounts exist, unless KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=<exact count> is set; otherwise the run is refused before any write" },
  { id: "A3", group: "A", role: "admin+member", writes: false, text: "knowledge tables are reachable and knowledge_review exists (all-zero id: admin -> P0002 not found, member -> 42501), so 0009 is live" },
  { id: "A4", group: "A", role: "admin", writes: false, text: "baselines recorded (knowledge_items, knowledge_events, answer_feedback, chat_audit) and equal to the expected values" },
  { id: "A5", group: "A", role: "member", writes: false, text: "0010 live: intent 'knowledge' passes the audit CHECK. Two probes that cannot store a row (control: bogus intent -> intent CHECK; real: 'knowledge' -> reaches the later latency CHECK)" },
  // B. member boundary
  { id: "B1", group: "B", role: "member", writes: true, text: "member submits a valid proposal as themself: status proposed, author = member, unreviewed, history has one 'submitted' event" },
  { id: "B2", group: "B", role: "member", writes: false, text: "member cannot insert with status 'approved' (column privilege, 42501)" },
  { id: "B3", group: "B", role: "member", writes: false, text: "member cannot insert as another author (RLS, 42501)" },
  { id: "B4", group: "B", role: "member", writes: false, text: "member cannot set reviewed_by, reviewed_at, review_note, id, created_at, updated_at, effective_from or organization_id (42501 each)" },
  { id: "B5", group: "B", role: "member", writes: false, text: "member cannot pair source_type 'correction' with another kind (CHECK, 23514)" },
  { id: "B6", group: "B", role: "member", writes: false, text: "member cannot approve, reject or expire (knowledge_review -> 42501), and the item is unchanged afterwards (read by admin)" },
  { id: "B7", group: "B", role: "member", writes: false, text: "member cannot UPDATE or DELETE knowledge_items (42501); the item is unchanged" },
  { id: "B8", group: "B", role: "member", writes: false, text: "member cannot read or write knowledge_events (history)" },
  { id: "B9", group: "B", role: "member", writes: true, text: "admin's private proposal is invisible to the member (by id and by run marker)" },
  { id: "B10", group: "B", role: "member", writes: false, text: "member sees their own submission in every status (documented policy), including their own rejected item" },
  { id: "B11", group: "B", role: "member", writes: false, text: "normal Brain retrieval path (repository listCurrent + knowledge adapter) returns neither proposed nor rejected items" },
  { id: "B12", group: "B", role: "anon", writes: false, text: "anon cannot read knowledge, insert, or call knowledge_review" },
  // C. admin review lifecycle
  { id: "C1", group: "C", role: "admin", writes: true, text: "admin approves the member's proposal with a note: approved, reviewer = admin, note stored, history = submitted, approved" },
  { id: "C2", group: "C", role: "admin+member", writes: false, text: "the approved item is now retrievable by the member (listCurrent and adapter)" },
  { id: "C3", group: "C", role: "admin", writes: false, text: "reject without a reason (null and blank) is refused (22023); item stays proposed" },
  { id: "C4", group: "C", role: "admin", writes: true, text: "reject with a reason: rejected, reason stored, history ends 'rejected', excluded from retrieval" },
  { id: "C5", group: "C", role: "admin", writes: false, text: "invalid transitions and calls refused: approve/reject an approved item, expire a proposed or rejected item, approve a rejected item, unknown action, unknown id (P0002), note over 500 characters" },
  { id: "C6", group: "C", role: "admin+member", writes: true, text: "approving a member's replacement supersedes the intended prior item in the same call: old superseded, new approved, both events written, old excluded from retrieval, old cannot be expired" },
  { id: "C7", group: "C", role: "member", writes: false, text: "member cannot name a proposed (not approved) or non-existent item as the one to replace (42501)" },
  { id: "C8", group: "C", role: "admin+member", writes: true, text: "admin expires an approved item: expired, original reviewer kept, event written, excluded from retrieval" },
  { id: "C9", group: "C", role: "admin", writes: true, text: "DOCUMENTED DESIGN: an admin approves their own submission; allowed, and the history shows the same actor. Recorded as behaviour, not a defect" },
  { id: "C10", group: "C", role: "admin", writes: false, text: "even an administrator cannot UPDATE/DELETE knowledge_items or write knowledge_events/answer_feedback rows directly (42501)" },
  // D. scope isolation and expiry
  { id: "D1", group: "D", role: "admin", writes: true, text: "approving a proposal whose expiry has already passed is refused (55000)" },
  { id: "D2", group: "D", role: "admin+member", writes: true, text: "an approved item with a near expiry is retrievable, then disappears from retrieval once expired (no admin action)" },
  { id: "D3", group: "D", role: "admin+member", writes: true, text: "two approved items with the same topic and different text are reported as a conflict, not silently resolved" },
  { id: "D4", group: "D", role: "none", writes: false, text: "stale-item labelling (180 days): BLOCKED, reviewed_at is set by the database and cannot be back-dated without bypassing it; covered by tests/knowledge.test.ts" },
  { id: "D5", group: "D", role: "member", writes: false, text: "scope rules are enforced by the database: project scope without project, organization scope with project, project_note without project, bad topic, short title, long body, unknown project (all refused)" },
  { id: "D6", group: "D", role: "member", writes: true, text: "member can propose knowledge for an ACTIVE project they can see (needs an existing active project, else BLOCKED)" },
  { id: "D7", group: "D", role: "admin+member", writes: true, text: "ARCHIVED project: member cannot propose for it (42501) and cannot read its approved knowledge (needs an existing archived project, else BLOCKED)" },
  { id: "D8", group: "D", role: "admin+member", writes: true, text: "approved knowledge for an ACTIVE project is retrievable by the member (needs an existing active project, else BLOCKED)" },
  // E. feedback and audit compatibility
  { id: "E1", group: "E", role: "member", writes: true, text: "member records valid metadata-only feedback; the admin reads it back and it has exactly the metadata columns, no text" },
  { id: "E2", group: "E", role: "member", writes: false, text: "invalid feedback is refused: bad rating, free-text reason, free-text intent, unknown source id, extra question/comment/answer columns, forged actor, id/created_at" },
  { id: "E3", group: "E", role: "member", writes: false, text: "member cannot read, update or delete feedback; anon cannot insert it" },
  { id: "E4", group: "E", role: "member", writes: false, text: "existing chat_audit protections hold: member reads nothing, cannot update or delete, anon cannot read" },
  { id: "E5", group: "E", role: "none", writes: false, text: "source_ids 'knowledge' accepted by chat_audit: BLOCKED live (any probe that could succeed stores a permanent row); verified by the read-only catalog audit instead" },
  { id: "E6", group: "E", role: "admin", writes: false, text: "chat_audit row count after the run equals the baseline (this script never inserts one)" },
  // G. drafts 0011 (replacement guard, content removal) and 0012 (database secret screen), live on broko-dev. Secret-shaped strings are built from parts at run time.
  { id: "G1", group: "G", role: "member", writes: true, text: "0011 live: a replacement must match the item it replaces on topic; a different topic, no topic where the item has one, and a topic where it has none are all refused (42501) and nothing is stored; the same topic is accepted" },
  { id: "G2", group: "G", role: "admin", writes: false, text: "0011 approval-time mismatch refusal (23514): BLOCKED live, a mismatched row cannot be inserted through the API (the insert policy stops it first); covered by the local PGlite test with an owner-inserted row" },
  { id: "G3", group: "G", role: "member", writes: false, text: "0012 live: every format the database enforces (shared corpus tests/fixtures/secret-corpus.json) is refused on insert with 23514, the message names the pattern id only and never echoes the text, and nothing is stored" },
  { id: "G4", group: "G", role: "member+admin", writes: false, text: "0012 live: a key in the title, a key in the source note, a key split by a zero-width character, and a key in an ADMINISTRATOR's own proposal are all refused (23514)" },
  { id: "G5", group: "G", role: "member", writes: true, text: "0012 live control: ordinary text that merely mentions passwords, keys and a ticket id is accepted (the screen is not broader than its seven formats)" },
  { id: "G6", group: "G", role: "admin", writes: true, text: "0012 live: a credential in an approve, reject or expire NOTE is refused (23514, no echo); status, reviewer and history are unchanged; a normal note still approves" },
  { id: "G7", group: "G", role: "member+anon", writes: false, text: "0012 live: neither the detector nor either guard function can be called through the API by a member or by anon" },
  { id: "G8", group: "G", role: "member+anon", writes: false, text: "0011 live: a member and anon cannot call knowledge_redact; the target is unchanged" },
  { id: "G9", group: "G", role: "admin", writes: false, text: "0011 live: knowledge_redact refuses an unknown or null reason (22023) and an unknown item (P0002)" },
  { id: "G10", group: "G", role: "admin+member", writes: true, text: "0011 live: redacting an APPROVED item blanks title/body/topic/source note/review note, sets redacted_at, expires it, clears earlier history notes, writes one 'redacted' event with a fixed note, removes it from retrieval, keeps the original approver; other items are untouched" },
  { id: "G11", group: "G", role: "admin", writes: true, text: "0011 live: redacting a PROPOSED item rejects it and records the administrator; a second redaction and any later review are refused (55000)" },
  { id: "G12", group: "G", role: "member", writes: false, text: "0011 live: a member cannot name a redacted item as the one to replace (42501)" },
  // F. cleanup
  { id: "F1", group: "F", role: "admin", writes: true, text: "cleanup (only this run's ids plus a sweep of this run's unique marker): rejects still-proposed items, expires still-approved items" },
  { id: "F2", group: "F", role: "admin+member", writes: false, text: "after cleanup no item of this run is proposed or approved, and none is in the member's retrieval" },
  { id: "F3", group: "F", role: "admin", writes: false, text: "residue report: counts that cannot be removed through the API, with the manifest file path" },
];

export const PLAN_IDS: ReadonlySet<string> = new Set(PLAN.map((s) => s.id));

export const CLEANUP_STRATEGY: readonly string[] = [
  "Everything this run creates carries a unique marker: the title starts with '[LIVE-TEST <runId>]' and the topic starts with 'livetest-<hex>'. Pre-existing rows are never selected by id or by pattern.",
  "A manifest (run id, every created item id, every feedback id, timestamps; no secrets, no text) is written to the OS temp folder after EACH insert, so it survives a crash.",
  "Cleanup runs in a finally block as the ADMIN SESSION through the only legal path, public.knowledge_review(): still-proposed items are rejected with a reason, still-approved items are expired. Nothing is approved at the end; nothing stays visible to real users.",
  "Safety net: every item is created with expires_at = database time + 10 minutes, so even if this process is killed before cleanup, nothing stays retrievable by real users for longer than that.",
  "Eager retirement: each approved item is expired through knowledge_review() right after the last assertion that needs it, so the visibility window is seconds, not the whole run. Final cleanup stays as the backstop.",
  "A sweep reads (as admin) the items whose title carries this run's marker, to catch an insert whose response was lost. Writes are never retried automatically.",
  "The API cannot DELETE or UPDATE rows (by design, and this script never disables RLS, relaxes a policy or grants anything). So the rows remain, in a terminal, invisible state: knowledge_items, their knowledge_events and the answer_feedback rows.",
  "If you want them physically removed, --print-purge-sql <manifest> PRINTS a DELETE script scoped to the manifest ids. It is never executed by this script; running it (as the database owner) needs your separate approval.",
];

/** Every test item expires this long after DATABASE time unless the check needs a specific expiry. */
export const SAFETY_NET_MS = 10 * 60 * 1000;
export const safetyExpiry = (dbNowMs: number): string => new Date(dbNowMs + SAFETY_NET_MS).toISOString();

/**
 * Presence check. `others` is the number of accounts besides the two test accounts (a count only; no ids, names or emails are ever read).
 * The override must equal the observed count, so it cannot be set blindly in advance and goes stale when someone is added.
 */
export function presenceVerdict(others: number, allow: string | undefined): { ok: boolean; message: string } {
  if (others === 0) return { ok: true, message: "no accounts other than the two test accounts" };
  if (allow !== undefined && /^\d+$/.test(allow.trim()) && Number(allow.trim()) === others) {
    return { ok: true, message: `${others} other account(s) present; acknowledged by KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=${others}` };
  }
  return { ok: false, message: `${others} other account(s) exist and could see the synthetic approved items; refusing. To proceed knowingly, set KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=${others} (the exact count)` };
}

/** A unique run id: UTC time to the second plus 6 random hex characters. */
export function newRunId(now: Date = new Date(), rand: () => number = Math.random): string {
  const t = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = Array.from({ length: 6 }, () => Math.floor(rand() * 16).toString(16)).join("");
  return `${t}-${r}`;
}
export const markerOf = (runId: string) => `[LIVE-TEST ${runId}]`;
export const titleOf = (runId: string, label: string) => `${markerOf(runId)} ${label}`.slice(0, 160);
export const topicPrefixOf = (runId: string) => `livetest-${runId.split("-")[1] ?? "x"}`;
export const topicOf = (runId: string, n: string) => `${topicPrefixOf(runId)}-${n}`.slice(0, 60);

/** A letters-only word unique to the run, so a free-text search can find this run's items and nothing else. */
export const wordOf = (runId: string) => "lt" + [...(runId.split("-")[1] ?? "0")].map((c) => "abcdefghij"[parseInt(c, 16) % 10]).join("");

export interface Manifest { runId: string; startedAt: string; target: string; items: { id: string; label: string; author: "admin" | "member" }[]; feedback: string[] }

/** Decodes the (non-secret) claims of a JWT-style key to refuse a service-role key. Returns null for non-JWT keys. Never returns the key. */
export function keyRole(key: string): string | null {
  if (key.startsWith("sb_secret_")) return "service_role";
  if (key.startsWith("sb_publishable_")) return "anon";
  const part = key.split(".")[1];
  if (!part) return null;
  try { return (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { role?: string }).role ?? null; } catch { return null; }
}

export interface TargetInput { url: string | undefined; confirm: string | undefined; key: string | undefined; linkedRef: string | null }
/** Returns the reasons the run must be refused. An empty list means the target is positively identified as broko-dev. */
export function targetProblems(t: TargetInput): string[] {
  const out: string[] = [];
  let host = "";
  try { const u = new URL(t.url ?? ""); host = u.hostname.split(".")[0]; if (u.protocol !== "https:" || !u.hostname.endsWith(".supabase.co")) out.push("URL is not an https *.supabase.co project URL"); } catch { out.push("URL is missing or invalid"); }
  if (host !== DEV_REF) out.push("URL project ref is not the approved development project");
  if (t.confirm !== "broko-dev") out.push("PRECON_LIVE_CONFIRM=broko-dev is missing");
  if (t.linkedRef !== DEV_REF) out.push("the locally linked Supabase project is not the approved development project");
  if (!t.key) out.push("PRECON_LIVE_ANON_KEY is missing");
  else if (keyRole(t.key) !== "anon" && keyRole(t.key) !== null) out.push("the key is not a publishable/anon key (secret and service-role keys are refused)");
  return out;
}

const uuidList = (ids: string[]) => ids.map((i) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i)) throw new Error("not a uuid"); return `'${i.toLowerCase()}'`; }).join(", ");

/** SQL (printed, never executed by the script) that removes exactly one run's rows, children first. Run as the database owner only after approval. */
export function purgeSql(m: Manifest): string {
  const items = m.items.map((i) => i.id);
  const lines = [`-- Purge of live test run ${m.runId} on broko-dev (${DEV_REF}). Generated, NOT executed. Review, then run only with explicit approval.`, "begin;"];
  if (m.feedback.length) lines.push(`delete from public.answer_feedback where id in (${uuidList(m.feedback)});`);
  if (items.length) {
    lines.push(`delete from public.knowledge_events where item_id in (${uuidList(items)});`);
    lines.push(`delete from public.knowledge_items where id in (${uuidList(items)}) and (title like '${markerOf(m.runId).replace(/'/g, "''")}%' or redacted_at is not null);`);
  }
  lines.push("-- expect: the deleted counts above equal the manifest counts; then commit, otherwise rollback.", "rollback; -- change to commit only after checking the counts");
  return lines.join("\n");
}
