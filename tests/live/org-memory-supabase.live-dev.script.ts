/**
 * LIVE verification of Phase 2A organizational memory (migration 0013) against the DEVELOPMENT Supabase project. NOT part of `npm test`.
 * Every database call is made as a signed-in user with the publishable (anon) key. No service-role key is read or accepted anywhere.
 *
 *   node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-memory-supabase.live-dev.script.ts --dry-run
 *   node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-memory-supabase.live-dev.script.ts --execute [--wait-expiry]
 *   node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-memory-supabase.live-dev.script.ts --verify-persisted <state-file>
 *
 * SIGNALS: SIGINT/SIGTERM/SIGBREAK/SIGHUP stop the run at the next step and trigger the same cleanup (best effort). SIGKILL, a crash, power loss or a Windows console
 * closed without a signal can bypass handlers: run --cleanup <state file> (the path is printed at the start of --execute). A leftover lock expires by itself after 15 minutes.
 * PREFLIGHT: read-only counts of active documents outside this run (real ones, and synthetic ones left by another run). If either is not zero, K1-K4 are SKIPPED (inconclusive).
 *
 * K-ONLY MODE: add --k-only to --dry-run or --execute to run ONLY K1 and K2 against ONE synthetic source in its own workspace live-konly-<runId> (no member, no
 *   lifecycle, no Knowledge, no relationships); see kOnlyRun(). --cleanup <state-file> also understands the state file such a run writes.
 *
 * MODES (exactly one):
 *   --dry-run            no network: prints the plan, the cleanup strategy and which credential NAMES are set (never values)
 *   --execute            runs the suite. --wait-expiry additionally holds the run lock for 15 minutes to prove expired-lock recovery (otherwise that check is BLOCKED)
 *   --cleanup <file>     recovery for a killed run: archives exactly that run's synthetic workspace/source ids and releases the run locks it recorded (refuses any other ids)
 *   --verify-persisted   a FRESH process: signs in as admin and re-reads what a previous --execute stored (state file path is printed at the end of --execute)
 *
 * Environment (same names as the other live scripts; set in the window that runs it, never in a file): PRECON_LIVE_URL, PRECON_LIVE_CONFIRM=broko-dev,
 * PRECON_LIVE_ANON_KEY, PRECON_LIVE_ADMIN_EMAIL/_PASSWORD, PRECON_LIVE_MEMBER_EMAIL/_PASSWORD. The Claude checks also need ANTHROPIC_API_KEY.
 *
 * ISOLATION: all synthetic data lives in its own workspace id ("live-test-<runId>") with the source ids "<runId>-pN"; real records are never read for assertions
 * and never changed. The synthetic content is a fake fixture (a fake Notion connector), so real Notion pages are never altered.
 * CLEANUP: the API has no DELETE by design. At the end (also after a failure) the admin archives every synthetic source through org_memory_archive_doc, which hides
 * its records from retrieval; rows remain and removing them needs a separate, explicit approval. Any run lock this script took is released.
 *
 * Exit code: 0 = every executed check passed (BLOCKED checks are listed, not hidden), 1 = a check failed, 2 = refused or aborted before any write,
 * 3 = nothing failed but some checks were SKIPPED as inconclusive (that is NOT a pass for those checks).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chatToolAgent, gateRelationshipTool } from "../../src/lib/chat-model";
import { createMemoryRateLimiter } from "../../src/lib/ai-brain/chat";
import { createToolAgent, isCoverageStatement } from "../../src/lib/ai-brain/chat/tool-agent";
import { handleChat } from "../../src/lib/chat-service";
import { handleIngest } from "../../src/lib/org-memory-service";
import { createToolTransport, type ToolTransport } from "../../src/lib/ai-brain/model-tool-transport";
import { loadAiBrainConfig } from "../../src/lib/ai-brain";
import { searchWords } from "../../src/lib/ai-brain/org-memory/query";
import { unavailableConnectors, type NotionConnector } from "../../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../../src/lib/ai-brain/assistant/meetings/types";
import { proposeToKnowledge, type Extractor, type OrgEntity, type SourceDoc } from "../../src/lib/ai-brain/org-memory";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../../src/lib/backend/supabase/profile";
import { createSupabaseKnowledgeRepo } from "../../src/lib/backend/supabase/knowledge";
import { createSupabaseOrgMemory } from "../../src/lib/backend/supabase/org-memory";
import type { Repo } from "../../src/lib/backend/types";
import type { Profile } from "../../src/lib/types";
import { fakeRepo } from "../ai-chat-helpers";
import { openResultsLog, type ResultsLog } from "./lib/results-log";
import { DEV_REF, newRunId, presenceVerdict, targetProblems } from "./lib/knowledge-live-plan";
import { cleanupProblems, describeAmbiguity, KONLY_WS_PREFIX, onlyIfEmpty, sanitizeDiag, signInFailureMessage, stateProblems, type Ambiguity, type State } from "./lib/org-memory-live-plan";

class Abort extends Error {}
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Abort(`Missing ${k}`); return v; };
const ZERO = "00000000-0000-4000-8000-000000000000";
type Err = { code?: string; message?: string } | null;
const why = (e: Err) => (e ? `${e.code ?? "?"}: ${String(e.message ?? "").slice(0, 80)}` : "no error");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HEX64 = /^[0-9a-f]{64}$/;

// ------------------------------------------------------------------------------------------------ the plan (every id the script may report)
interface Step { id: string; group: string; writes: boolean; text: string }
const PLAN: readonly Step[] = [
  { id: "A1", group: "A target", writes: false, text: "URL host is exactly the broko-dev ref, PRECON_LIVE_CONFIRM=broko-dev, the locally linked project is that ref, the key is not a secret key" },
  { id: "A2", group: "A target", writes: false, text: "separate admin and member sessions sign in with roles admin and member" },
  { id: "B1", group: "B ingestion", writes: true, text: "admin ingestion through handleIngest: status ok, 2 sources created, 2 extracted" },
  { id: "B2", group: "B ingestion", writes: false, text: "L0 re-read from Supabase: documents present, sha-256 hashes, source refs, admin scope, extracted hash = content hash" },
  { id: "B3", group: "B ingestion", writes: false, text: "L1 re-read from Supabase: expected records, all proposed, none promoted, none auto-approved" },
  { id: "B4", group: "B ingestion", writes: false, text: "every evidence reference resolves to a stored segment, and owner/team/due appear in the cited text" },
  { id: "B5", group: "B ingestion", writes: false, text: "an unsupported owner and an unsupported date were dropped (counted) and are not stored" },
  { id: "B6", group: "B ingestion", writes: false, text: "the EXACT run this script started (by its recorded id) is recorded with counts only (no titles or text) and finished, so its lock is released" },
  { id: "I1", group: "I idempotency", writes: true, text: "second run over unchanged sources: nothing created or changed; document and record ids and hashes identical" },
  { id: "I2", group: "I idempotency", writes: true, text: "edit time bumped, content identical: fetched but classified unchanged; hashes stable; no duplicates" },
  { id: "I3", group: "I revision", writes: true, text: "changed source: new hash detected; a REVIEWED record is not overwritten (stale + pending revision); history keeps the approval" },
  { id: "I4", group: "I revision", writes: true, text: "a REJECTED record stays rejected after the changed-source run; new records stay proposed" },
  { id: "I5", group: "I revision", writes: true, text: "accept_revision applies the pending revision, clears stale, and keeps the review history" },
  { id: "R1", group: "R run lock", writes: true, text: "concurrent ingestion is refused while a run holds the lock (busy), the held run still completes ok" },
  { id: "R2", group: "R run lock", writes: true, text: "the lock is released after completion and after failure; a member cannot take it" },
  { id: "R3", group: "R run lock", writes: true, text: "expired lock (15 minutes) is recovered by the next run (needs --wait-expiry)" },
  { id: "R4", group: "R failure", writes: true, text: "failed ingestion (discovery failure) reports failed, writes nothing, releases the lock" },
  { id: "R5", group: "R failure", writes: true, text: "partial ingestion (one source unreadable): status partial, source recorded as failed with an attempt, no entities for it" },
  { id: "R6", group: "R failure", writes: true, text: "retry after failure: the source is read again and stored; no duplicate documents or records" },
  { id: "M1", group: "M member", writes: false, text: "member's repository refuses reads: no entities, no entity by id, no document, no review queue; review throws" },
  { id: "M2", group: "M member", writes: false, text: "member's direct table reads return nothing (real ids and a random id); counts reveal nothing" },
  { id: "M3", group: "M member", writes: false, text: "member's direct calls to all 10 memory functions are denied (42501) and return no data" },
  { id: "M4", group: "M member", writes: false, text: "member's ingestion attempt is refused (forbidden) before Notion or the model is touched" },
  { id: "M5", group: "M member", writes: false, text: "anon: table reads and function calls denied" },
  { id: "K1", group: "K Claude", writes: false, text: "(SKIPPED if any active non-synthetic or other-run document exists) real Claude, admin: the memory tool is invoked against persisted rows (repository reads happen) and the answer is the memory answer" },
  { id: "K2", group: "K Claude", writes: false, text: "cited segment ids exist in the stored source; the answer says proposed / not reviewed" },
  { id: "K3", group: "K Claude", writes: false, text: "typos / informal question handled; missing evidence disclosed; no invented owner, date or number" },
  { id: "K4", group: "K Claude", writes: false, text: "real Claude, member: no memory content in the reply, no record read by the member's repository" },
  { id: "L1", group: "L Knowledge", writes: true, text: "a reviewed record is proposed to Knowledge: item is PROPOSED (not approved), the record is promotion_proposed, provenance kept" },
  { id: "L2", group: "L Knowledge", writes: true, text: "human approval needed: member cannot approve; admin approves; approved is distinguishable from proposed; expired again right away" },
  { id: "L3", group: "L Knowledge", writes: true, text: "rejecting a Knowledge proposal keeps the source document and the L1 record" },
  { id: "P1", group: "P durability", writes: false, text: "state file written for a FRESH process to re-read (run --verify-persisted)" },
  // ---- --k-only mode only (never part of the full run)
  { id: "KA1", group: "KO K-only", writes: false, text: "the signed-in admin account has the admin role (target guard A1 passed first; no member session is used)" },
  { id: "KA2", group: "KO K-only", writes: false, text: "preflight before any write: workspace live-konly-<runId> has no document, the source id is unused anywhere, no real or other-run active document exists, the Claude key is present, a before-fingerprint of the existing rows is taken" },
  { id: "KB1", group: "KO K-only", writes: true, text: "ONE synthetic source ingested through handleIngest: status ok, 1 created, 1 extracted" },
  { id: "KB2", group: "KO K-only", writes: false, text: "stored record re-read: exactly 1 record 'Confirm warehouse slot', proposed, not stale, evidence S2 resolves to a stored segment that contains the owner and team" },
  { id: "KC1", group: "KO K-only", writes: true, text: "cleanup: this run's single source is archived and verified archived; the run lock is released" },
  { id: "KC2", group: "KO K-only", writes: false, text: "every row that existed before the run (documents, records, relationships, Knowledge items) is unchanged, by fingerprint; residual synthetic rows are listed" },
];

/** The ids a --k-only run reports (A1 comes from the shared target guard). */
const KONLY_IDS = ["A1", "KA1", "KA2", "KB1", "KB2", "K1", "K2", "KC1", "KC2"] as const;

/** SKIPPED = deliberately not run because it could not be made unambiguous (never counted as a pass; logged as BLOCKED with a SKIPPED reason). */
type Status = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";
const reported = new Set<string>();
const tally: Record<Status, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0 };
/** Set by SIGINT/SIGTERM. The next check or sleep slice stops the run so the cleanup in `finally` can happen. */
let interrupted = false;
let rlog: ResultsLog | null = null;
function report(id: string, status: Status, detail?: string) {
  const step = PLAN.find((s) => s.id === id);
  if (!step) throw new Error(`unplanned check id ${id}`);
  reported.add(id); tally[status]++;
  if (status === "SKIPPED") rlog?.record(id, step.text, "BLOCKED", undefined, `SKIPPED (inconclusive): ${detail ?? ""}`);
  else rlog?.record(id, step.text, status, status === "FAIL" ? detail : undefined, status === "BLOCKED" ? detail : undefined);
  // K1/K2 only: keep the content-free diagnostics next to the check record (the results-log writer itself is unchanged: it keeps codes only).
  if ((id === "K1" || id === "K2") && (status === "PASS" || status === "FAIL") && rlog && existsSync(rlog.path)) {
    const line = detailLine(id, status, detail, new Date().toISOString());
    if (line) { try { appendFileSync(rlog.path, `${line}\n`, "utf8"); } catch { /* diagnostics are best effort: the run goes on */ } }
  }
  console.log(`${status.padEnd(7)} ${id.padEnd(3)} ${step.text}${detail ? `  (${detail})` : ""}`);
  if (interrupted) throw new Abort("interrupted by a signal; cleaning up");
}
const check = (id: string, ok: boolean, detail?: string) => report(id, ok ? "PASS" : "FAIL", detail);
const blocked = (id: string, reason: string) => report(id, "BLOCKED", reason);
const skipped = (id: string, reason: string) => report(id, "SKIPPED", reason);
const info = (s: string) => console.log(`INFO            ${s}`);

// ------------------------------------------------------------------------------------------------ dry run
function localLinkedRef(): string | null { try { return readFileSync(join(process.cwd(), "supabase", ".temp", "project-ref"), "utf8").trim(); } catch { return null; } }
function dryRun() {
  console.log("\n=== Organizational memory live test plan (DRY RUN: nothing is contacted or written) ===");
  let g = "";
  for (const s of PLAN.filter((x) => x.group !== "KO K-only")) { if (s.group !== g) { g = s.group; console.log(`\n[${g}]`); } console.log(`  ${s.id.padEnd(3)} ${s.writes ? "WRITES" : "read  "} ${s.text}`); }
  console.log("\n=== Cleanup and recovery ===\n  at the end, on SIGINT/SIGTERM/SIGBREAK/SIGHUP, or via --cleanup <state-file>: ONLY this run's workspace live-test-<runId> and its three source ids <runId>-p1..3 are archived (hidden from retrieval), and only the run locks this run recorded are released; any other id is refused. Rows stay until a separate approval. Forced termination or a crash can bypass the signal handlers: use --cleanup.");
  console.log("\n=== Preflight (read-only, before and again right before the Claude checks) ===\n  counts ACTIVE documents that are not this run's (non-synthetic, and synthetic from other runs); if either is not zero, or unknown, K1-K4 are SKIPPED as INCONCLUSIVE");
  console.log("\n=== Target guard (local checks only) ===");
  const linked = localLinkedRef();
  console.log(`  approved project ref : ${DEV_REF}\n  locally linked ref   : ${linked === DEV_REF ? "matches" : linked === null ? "not found" : "DOES NOT MATCH"}`);
  for (const k of ["PRECON_LIVE_URL", "PRECON_LIVE_CONFIRM", "PRECON_LIVE_ANON_KEY", "PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD", "PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD", "ANTHROPIC_API_KEY"]) console.log(`  ${k.padEnd(28)}: ${process.env[k] ? "set" : "NOT SET"}`);
  const problems = targetProblems({ url: process.env.PRECON_LIVE_URL, confirm: process.env.PRECON_LIVE_CONFIRM, key: process.env.PRECON_LIVE_ANON_KEY, linkedRef: linked });
  console.log(problems.length ? `  a live run would be REFUSED now:\n${problems.map((p) => `    - ${p}`).join("\n")}` : "  target guard: passes");
}

// ------------------------------------------------------------------------------------------------ sessions
interface Session { db: SupabaseClient; profile: Profile }
let url = ""; let anonKey = "";
async function signIn(emailKey: string, passKey: string): Promise<Session> {
  const db = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.auth.signInWithPassword({ email: need(emailKey), password: need(passKey) });
  if (error) throw new Abort(signInFailureMessage(emailKey, error)); // status and code only; the provider message is never echoed
  const { data: u } = await db.auth.getUser();
  if (!u.user) throw new Abort(`No user after sign-in for ${emailKey}.`);
  const { data: row } = await db.from("profiles").select(PROFILE_COLUMNS).eq("id", u.user.id).maybeSingle();
  if (!row) throw new Abort("No profile row for the signed-in user.");
  return { db, profile: toProfile(row as ProfileRow, u.user.email) };
}
function guard(): void {
  const problems = targetProblems({ url: process.env.PRECON_LIVE_URL, confirm: process.env.PRECON_LIVE_CONFIRM, key: process.env.PRECON_LIVE_ANON_KEY, linkedRef: localLinkedRef() });
  if (problems.length) { check("A1", false, problems.join("; ")); throw new Abort(`Refusing to run: ${problems.join("; ")}`); }
  url = need("PRECON_LIVE_URL"); anonKey = need("PRECON_LIVE_ANON_KEY");
}

// ------------------------------------------------------------------------------------------------ the synthetic source (a fake Notion connector)
interface Page { title: string; edited: string; lines: string[] }
interface Control { listFail: boolean; failIds: Set<string>; gate: Promise<void> | null; reads: number }
const NOW_ISO = () => new Date().toISOString();
function notionOf(pages: Map<string, Page>, ctl: Control): NotionConnector {
  return {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() {
      if (ctl.gate) await ctl.gate;
      if (ctl.listFail) return { ok: false, reason: "not_connected" };
      return { ok: true, data: [...pages].map(([id, p]) => ({ system: "notion", record_id: id, title: p.title, url: `https://www.notion.so/${id}`, last_edited: p.edited, date_only: false, date_source: "none", retrieved_at: NOW_ISO() }) as MeetingCandidate) };
    },
    async readMeetingDocument(id) {
      ctl.reads += 1;
      const p = pages.get(id);
      if (!p) return { ok: false, reason: "error" };
      if (ctl.failIds.has(id)) return { ok: false, reason: "rate_limited" };
      const segments = [p.title, ...p.lines].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? ("title" as const) : ("text" as const), text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: p.title, url: `https://www.notion.so/${id}`, last_edited: p.edited, date_only: false, date_source: "none", retrieved_at: NOW_ISO(), segments, coverage: { complete: true, gaps: [], blocks_read: segments.length } } as MeetingDocument };
    },
  };
}
/** Deterministic extraction over the fixture, so lifecycle checks do not depend on model variance. Includes one entity with an owner and a date the text does not support. */
const fixtureExtractor: Extractor = {
  async extract(doc: SourceDoc) {
    const find = (re: RegExp) => doc.segments.find((s) => re.test(s.text));
    const out: unknown[] = [];
    const task = find(/checklist/i);
    if (task) {
      out.push({ entity_type: "task", name: "Send Halcyon checklist", description: "Priya sends the Halcyon launch checklist.", evidence: [task.id], basis: "explicit", confidence: "high", owner: "Priya", due: /Monday/.test(task.text) ? "Monday" : "Friday" });
      out.push({ entity_type: "task", name: "Review Halcyon vendor list", description: "The vendor list needs a review.", evidence: [task.id], basis: "extracted", confidence: "medium", owner: "Zed", due: "March 3" }); // unsupported on purpose
    }
    const dec = find(/^Decision:/i);
    if (dec) out.push({ entity_type: "decision", name: "Launch Halcyon in Pune", description: "Launch the Halcyon marketplace in Pune first.", evidence: [dec.id], basis: "explicit", confidence: "high" });
    const ops = find(/Operations/);
    if (ops) out.push({ entity_type: "task", name: "Confirm warehouse slot", description: "Dana confirms the warehouse slot.", evidence: [ops.id], basis: "explicit", confidence: "high", owner: "Dana", team: "Operations" });
    return { ok: true, raw: out, truncated: false };
  },
};

// ------------------------------------------------------------------------------------------------ the live run
const STATE_DIR = join(tmpdir(), "broko-org-memory-live");
const stateFileOf = (runId: string) => join(STATE_DIR, `${runId}.state.json`);
/** Written as soon as the workspace is chosen (before any remote write) and again whenever a lock is taken or released: it holds ids and counts only, never credentials. */
function persistState(s: State): boolean {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(stateFileOf(s.runId), JSON.stringify(s), "utf8"); return true; } catch { return false; }
}
/** Releases the run locks this run took, then archives exactly this run's three synthetic sources. Idempotent. Returns counts only. */
async function cleanupState(A: ReturnType<typeof createSupabaseOrgMemory>, s: State): Promise<{ released: number; archived: number; refused: string[] }> {
  const refused = cleanupProblems(s);
  if (refused.length) return { released: 0, archived: 0, refused };
  let released = 0; let archived = 0;
  for (const id of s.held) { try { await A.runs.finish(id, "failed", {}); released += 1; } catch { /* already finished, or it expires on its own after 15 minutes */ } }
  for (const src of s.sources) { try { await A.writer.archiveDoc("notion", s.ws, src); archived += 1; } catch { /* counted below */ } }
  s.held = [];
  persistState(s);
  return { released, archived, refused };
}
/** Sleeps in short slices so a signal can interrupt a long wait. */
async function sleepInterruptible(ms: number) { for (let left = ms; left > 0; left -= 2000) { if (interrupted) throw new Abort("interrupted by a signal; cleaning up"); await sleep(Math.min(2000, left)); } }
/** Read-only head counts of ACTIVE documents that are not this run's: real ones, and synthetic ones left by an earlier run. Null = could not be counted. */
async function ambiguity(db: SupabaseClient, ws: string): Promise<Ambiguity> {
  const real = await db.from("org_source_docs").select("id", { count: "exact", head: true }).eq("archived", false).not("workspace_id", "like", "live-test-%").not("workspace_id", "like", `${KONLY_WS_PREFIX}%`);
  const other = await db.from("org_source_docs").select("id", { count: "exact", head: true }).eq("archived", false).or(`workspace_id.like.live-test-%,workspace_id.like.${KONLY_WS_PREFIX}%`).neq("workspace_id", ws);
  return { real: real.error ? null : real.count, otherSynthetic: other.error ? null : other.count };
}

async function live() {
  const runId = newRunId();
  rlog = openResultsLog(STATE_DIR, runId);
  console.log(`RESULTS LOG       ${rlog.path}`);
  guard();
  check("A1", true);
  const admin = await signIn("PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  const member = await signIn("PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD");
  const okRoles = admin.profile.role === "admin" && member.profile.role === "member" && admin.profile.id !== member.profile.id;
  check("A2", okRoles);
  if (!okRoles) throw new Abort("Session roles are not as required.");

  const ws = `live-test-${runId}`;
  const sid = (n: number) => `${runId}-p${n}`;
  const A = createSupabaseOrgMemory(admin.db, admin.profile);
  const M = createSupabaseOrgMemory(member.db, member.profile);
  const state: State = { runId, ws, sources: [sid(1), sid(2), sid(3)], held: [], docs: [], entities: 0 };
  const stateFile = stateFileOf(runId);
  // Recovery state first, before any remote write: if this process is killed, --cleanup <this file> restores a clean state.
  console.log(persistState(state) ? `STATE FILE        ${stateFile}\n  recovery if this run is killed: node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-memory-supabase.live-dev.script.ts --cleanup "${stateFile}"` : "WARNING: could not write the recovery state file");
  const hold = (id: string) => { state.held.push(id); persistState(state); };
  const unhold = (id: string) => { state.held = state.held.filter((x) => x !== id); persistState(state); };
  let cleanupDone: Promise<void> | null = null;
  const cleanup = () => (cleanupDone ??= cleanupState(A, state).then((r) => info(r.refused.length ? `cleanup REFUSED: ${r.refused.join("; ")}` : `cleanup: ${r.archived}/${state.sources.length} synthetic sources archived, ${r.released} lock(s) released; workspace ${ws}`)));
  // Best effort: SIGINT (Ctrl-C), SIGTERM, SIGBREAK and SIGHUP stop the run at the next check and then clean up. SIGKILL, a crash, power loss or closing a
  // Windows console without a signal can bypass these handlers; run --cleanup <state file> afterwards. A watchdog starts cleanup anyway if the run has not stopped within 90 s.
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
    process.on(sig, () => { if (interrupted) return; interrupted = true; console.error(`${sig} received: stopping at the next step and cleaning up`); setTimeout(() => void cleanup(), 90_000).unref(); });
  }
  const preflight = await ambiguity(admin.db, ws);
  info(`preflight (read-only): ${describeAmbiguity(preflight)}`);
  const runIds: string[] = [];
  const pages = new Map<string, Page>([
    [sid(1), { title: `Halcyon weekly sync ${runId}`, edited: "2026-11-01T10:00:00.000Z", lines: ["Priya will send the Halcyon checklist by Friday.", "Decision: launch the Halcyon marketplace in Pune first."] }],
    [sid(2), { title: `Halcyon logistics ${runId}`, edited: "2026-11-01T11:00:00.000Z", lines: ["Dana from the Operations team will confirm the warehouse slot."] }],
  ]);
  const ctl: Control = { listFail: false, failIds: new Set(), gate: null, reads: 0 };
  const ingest = (u: Session, over: Partial<Parameters<typeof handleIngest>[0]> = {}) => handleIngest({
    // The wrapper only RECORDS the id of each run this script starts (so B6 can verify exactly that run); it changes no behaviour.
    user: u.profile, backendKind: "supabase", repoFor: async () => { const a = createSupabaseOrgMemory(u.db, u.profile); return { ...fakeRepo({}).repo, orgMemory: { ...a, runs: { ...a.runs, start: async () => { const r = await a.runs.start(); if (r.ok) runIds.push(r.id); return r; } } } }; },
    notion: notionOf(pages, ctl), extractor: fixtureExtractor, workspaceId: ws, log: () => undefined, ...over,
  });
  const docsOf = async () => { const r = await admin.db.from("org_source_docs").select("id,provider,workspace_id,source_id,content_hash,extracted_hash,access_scope,sync_status,attempts,archived,ingested_at,segments").eq("workspace_id", ws); if (r.error) throw new Abort(`read docs: ${why(r.error)}`); return r.data ?? []; };
  const entsOf = async () => { const out: OrgEntity[] = []; for (const d of await docsOf()) out.push(...(await A.reader.findEntities({ source_doc_id: d.id as string, include_rejected: true, limit: 50 }))); return out; };
  const byName = (es: OrgEntity[], n: string) => es.find((e) => e.name === n);

  try {
    // ---- B. admin ingestion and durable persistence
    const r1 = await ingest(admin);
    check("B1", r1.ok && r1.status === "ok" && r1.report.created === 2 && r1.report.extracted_docs === 2, r1.ok ? JSON.stringify({ status: r1.status, created: r1.report.created, extracted: r1.report.extracted_docs }) : r1.error);
    if (!r1.ok) throw new Abort("first ingestion failed; the rest cannot be evaluated");
    const docs1 = await docsOf();
    const okDocs = docs1.length === 2 && docs1.every((d) => HEX64.test(String(d.content_hash)) && d.extracted_hash === d.content_hash && d.access_scope === "admin" && d.provider === "notion" && d.sync_status === "synced" && String(d.source_id).startsWith(runId) && d.ingested_at);
    check("B2", okDocs, `docs=${docs1.length}`);
    const ents1 = await entsOf();
    state.entities = ents1.length;
    check("B3", ents1.length === 4 && ents1.every((e) => e.review_status === "proposed" && !e.knowledge_item_id && !e.stale), `records=${ents1.length}`);
    const segsOf = (docId: string) => (docs1.find((d) => d.id === docId)?.segments ?? []) as { id: string; text: string }[];
    const evidenceOk = ents1.every((e) => { const segs = segsOf(e.source_doc_id); const cited = e.evidence.map((id) => segs.find((s) => s.id === id)?.text ?? ""); return e.evidence.length > 0 && cited.every(Boolean) && [e.owner, e.team, e.due].every((v) => !v || cited.some((t) => t.includes(v))); });
    check("B4", evidenceOk);
    const vendor = byName(ents1, "Review Halcyon vendor list");
    check("B5", r1.report.owners_dropped >= 1 && r1.report.dates_dropped >= 1 && !ents1.some((e) => e.owner === "Zed" || e.due === "March 3") && !!vendor, `owners_dropped=${r1.report.owners_dropped} dates_dropped=${r1.report.dates_dropped}`);
    // B6 verifies EXACTLY the run this script started (its id was recorded when the run started), never the latest run of the table.
    const myRun = runIds[0];
    const runs = myRun ? await admin.db.from("org_ingest_runs").select("id,status,finished_at,started_by,report").eq("id", myRun).maybeSingle() : null;
    const mine = runs?.data;
    check("B6", !!myRun && runIds.length === 1 && !!runs && !runs.error && mine?.id === myRun && mine.started_by === admin.profile.id && mine.status === "ok" && !!mine.finished_at && !/Halcyon|Priya|Pune/.test(JSON.stringify(mine.report ?? {})), runs?.error ? why(runs.error) : `runs started so far by this script=${runIds.length}`);
    state.docs = docs1.map((d) => ({ source_id: String(d.source_id), content_hash: String(d.content_hash), segments: ((d.segments ?? []) as unknown[]).length }));

    // ---- I. idempotency
    const idsBefore = JSON.stringify([...docs1.map((d) => [d.id, d.content_hash])].sort());
    const entIdsBefore = JSON.stringify(ents1.map((e) => e.id).sort());
    const r2 = await ingest(admin);
    const docs2 = await docsOf(); const ents2 = await entsOf();
    check("I1", r2.ok && r2.report.created === 0 && r2.report.changed === 0 && r2.report.entities_created === 0 && JSON.stringify([...docs2.map((d) => [d.id, d.content_hash])].sort()) === idsBefore && JSON.stringify(ents2.map((e) => e.id).sort()) === entIdsBefore, r2.ok ? JSON.stringify({ created: r2.report.created, changed: r2.report.changed, skipped: r2.report.skipped }) : r2.error);
    pages.get(sid(2))!.edited = "2026-11-02T09:00:00.000Z"; // newer edit time, same text
    const r3 = await ingest(admin);
    const docs3 = await docsOf();
    check("I2", r3.ok && r3.report.changed === 0 && r3.report.created === 0 && docs3.length === 2 && docs3.every((d) => docs1.find((x) => x.id === d.id)?.content_hash === d.content_hash) && (await entsOf()).length === 4, r3.ok ? JSON.stringify({ unchanged: r3.report.unchanged, changed: r3.report.changed }) : r3.error);

    // review one record, reject another, then change the source
    const task = byName(ents1, "Send Halcyon checklist")!; const decision = byName(ents1, "Launch Halcyon in Pune")!;
    await A.reader.review(task.id, "approve", "live-test approval");
    await A.reader.review(decision.id, "reject", "live-test rejection");
    pages.get(sid(1))!.lines[0] = "Priya will send the Halcyon checklist by Monday.";
    pages.get(sid(1))!.edited = "2026-11-03T09:00:00.000Z";
    const r4 = await ingest(admin);
    const docs4 = await docsOf(); const ents4 = await entsOf();
    const task4 = byName(ents4, "Send Halcyon checklist"); const dec4 = byName(ents4, "Launch Halcyon in Pune");
    const hashChanged = docs4.find((d) => d.source_id === sid(1))?.content_hash !== docs1.find((d) => d.source_id === sid(1))?.content_hash;
    check("I3", r4.ok && r4.report.changed === 1 && hashChanged && !!task4 && task4.review_status === "reviewed" && task4.stale && task4.due === "Friday" && task4.pending_revision?.due === "Monday" && task4.history.some((h) => h.action === "approve"), r4.ok ? JSON.stringify({ changed: r4.report.changed, staled: r4.report.entities_staled }) : r4.error);
    check("I4", !!dec4 && dec4.review_status === "rejected" && ents4.filter((e) => e.review_status === "proposed").length >= 2 && ents4.length === 4, `records=${ents4.length}`);
    if (task4) await A.reader.review(task4.id, "accept_revision", "live-test accept");
    const task5 = byName(await entsOf(), "Send Halcyon checklist");
    check("I5", !!task5 && !task5.stale && task5.due === "Monday" && task5.pending_revision === null && task5.history.some((h) => h.action === "approve") && task5.history.some((h) => h.action === "accept_revision"));

    // ---- R. run lock and failure
    let release!: () => void;
    ctl.gate = new Promise<void>((res) => { release = res; });
    const held = ingest(admin); // blocked inside discovery while holding the lock
    await sleep(1500);
    const second = await ingest(admin);
    release(); ctl.gate = null;
    const heldDone = await held;
    check("R1", !second.ok && second.error === "busy" && heldDone.ok && heldDone.status === "ok", `second=${second.ok ? "ok" : second.error} held=${heldDone.ok ? heldDone.status : heldDone.error}`);
    const afterOk = await A.runs.start();
    if (afterOk.ok) { hold(afterOk.id); await A.runs.finish(afterOk.id, "ok", {}); unhold(afterOk.id); }
    ctl.listFail = true;
    const rFail = await ingest(admin);
    ctl.listFail = false;
    const afterFail = await A.runs.start();
    if (afterFail.ok) { hold(afterFail.id); await A.runs.finish(afterFail.id, "ok", {}); unhold(afterFail.id); }
    const memberStart = await M.runs.start();
    check("R2", afterOk.ok && afterFail.ok && !memberStart.ok && memberStart.reason === "forbidden", `afterOk=${afterOk.ok} afterFail=${afterFail.ok} member=${memberStart.ok ? "ok" : memberStart.reason}`);
    check("R4", rFail.ok && rFail.status === "failed" && rFail.report.discovery_failure === "not_connected" && rFail.report.created === 0 && (await docsOf()).length === 2, rFail.ok ? rFail.status : rFail.error);
    pages.set(sid(3), { title: `Halcyon risks ${runId}`, edited: "2026-11-04T09:00:00.000Z", lines: ["Dana from the Operations team will confirm the warehouse slot again."] });
    ctl.failIds.add(sid(3));
    const rPart = await ingest(admin);
    const failedDoc = (await docsOf()).find((d) => d.source_id === sid(3));
    check("R5", rPart.ok && rPart.status === "partial" && rPart.report.failed === 1 && failedDoc?.sync_status === "failed" && Number(failedDoc?.attempts) >= 1, rPart.ok ? rPart.status : rPart.error);
    ctl.failIds.clear();
    const rRetry = await ingest(admin);
    const docs6 = await docsOf();
    check("R6", rRetry.ok && rRetry.status === "ok" && rRetry.report.retried >= 1 && docs6.length === 3 && docs6.find((d) => d.source_id === sid(3))?.sync_status === "synced" && new Set(docs6.map((d) => d.source_id)).size === 3, rRetry.ok ? JSON.stringify({ retried: rRetry.report.retried }) : rRetry.error);

    // expired-lock recovery (needs real time to pass: the database lock expires after 15 minutes)
    if (process.argv.includes("--wait-expiry")) {
      const stuck = await A.runs.start();
      if (!stuck.ok) { check("R3", false, "could not take the lock"); } else {
        hold(stuck.id);
        const early = await A.runs.start();
        info("holding the lock for 15 minutes 30 seconds to prove expiry recovery...");
        await sleepInterruptible(15 * 60_000 + 30_000);
        const recovered = await A.runs.start();
        if (recovered.ok) { hold(recovered.id); await A.runs.finish(recovered.id, "ok", {}); unhold(recovered.id); }
        const old = await admin.db.from("org_ingest_runs").select("status,finished_at").eq("id", stuck.id).maybeSingle();
        unhold(stuck.id);
        check("R3", !early.ok && early.reason === "busy" && recovered.ok && old.data?.status === "failed" && !!old.data?.finished_at, `early=${early.ok ? "ok" : early.reason} recovered=${recovered.ok} closed_as=${old.data?.status ?? "?"}`);
      }
    } else blocked("R3", "needs 15 minutes of real time: rerun with --wait-expiry (the SQL clock logic is covered by the PGlite suite, 53/53)");

    // ---- M. member boundary (rows exist now, so empty results are meaningful)
    const entsNow = await entsOf();
    const someEntity = entsNow[0]!; const someDoc = docs6[0]!;
    const mFind = await M.reader.findEntities({ limit: 50, include_rejected: true });
    const mQueue = await M.reader.listReviewQueue(50);
    let mReviewThrew = false; try { await M.reader.review(someEntity.id, "approve", null); } catch { mReviewThrew = true; }
    check("M1", mFind.length === 0 && mQueue.length === 0 && (await M.reader.getEntity(someEntity.id)) === null && (await M.reader.getDocument(String(someDoc.id))) === null && mReviewThrew);
    const tables = ["org_source_docs", "org_entities", "org_entity_events", "org_ingest_runs"] as const;
    let leak = false;
    for (const t of tables) {
      const all = await member.db.from(t).select("id").limit(5);
      const byId = await member.db.from(t).select("id").eq("id", t === "org_source_docs" ? String(someDoc.id) : someEntity.id).limit(5);
      const rnd = await member.db.from(t).select("id").eq("id", ZERO).limit(5);
      const cnt = await member.db.from(t).select("id", { count: "exact", head: true });
      if ((all.data?.length ?? 0) > 0 || (byId.data?.length ?? 0) > 0 || (rnd.data?.length ?? 0) > 0 || (cnt.count ?? 0) > 0) leak = true;
    }
    check("M2", !leak);
    const calls: [string, Record<string, unknown>][] = [
      ["org_memory_upsert_doc", { p_provider: "notion", p_workspace: ws, p_source: "x", p_url: null, p_title: "x", p_type: "x", p_content: "x", p_segments: [], p_coverage: {}, p_hash: "x", p_last_edited: null, p_owner: null }],
      ["org_memory_record_failure", { p_provider: "notion", p_workspace: ws, p_source: "x", p_title: "x", p_url: null, p_code: "error" }],
      ["org_memory_archive_doc", { p_provider: "notion", p_workspace: ws, p_source: "x" }],
      ["org_memory_mark_extracted", { p_doc: ZERO, p_hash: "x", p_error: null }],
      ["org_memory_upsert_entity", { p_doc: ZERO, p_stable: "x", p_type: "task", p_name: "x", p_description: "x", p_evidence: ["S1"], p_basis: "explicit", p_confidence: "high", p_owner: null, p_team: null, p_due: null, p_unknowns: [] }],
      ["org_memory_stale_missing", { p_doc: ZERO, p_keep: [] }],
      ["org_memory_review", { p_id: someEntity.id, p_action: "approve", p_note: null }],
      ["org_memory_mark_promotion", { p_id: someEntity.id, p_knowledge: ZERO }],
      ["org_memory_run_start", {}],
      ["org_memory_run_finish", { p_run: ZERO, p_status: "ok", p_report: {} }],
    ];
    const denied: string[] = [];
    for (const [fn, args] of calls) { const r = await member.db.rpc(fn, args); if (r.error?.code === "42501" && (r.data === null || r.data === undefined)) denied.push(fn); else info(`member ${fn}: ${why(r.error)}`); }
    check("M3", denied.length === calls.length, `${denied.length}/${calls.length} denied`);
    const readsBefore = ctl.reads;
    const mIngest = await ingest(member);
    check("M4", !mIngest.ok && mIngest.error === "forbidden" && ctl.reads === readsBefore, mIngest.ok ? "ok?!" : mIngest.error);
    const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    let anonOk = true;
    for (const t of tables) { const r = await anon.from(t).select("id").limit(1); if (!(r.error?.code === "42501" || (r.data ?? []).length === 0) || (r.data ?? []).length > 0) anonOk = false; }
    for (const [fn, args] of calls) { const r = await anon.rpc(fn, args); if (!r.error) anonOk = false; }
    check("M5", anonOk);

    // ---- K. real Claude over the persisted rows
    // Re-check right before the Claude questions: a real document that appeared since the preflight would make the answers ambiguous.
    const beforeClaude = await ambiguity(admin.db, ws);
    info(`before Claude (read-only): ${describeAmbiguity(beforeClaude)}`);
    if (onlyIfEmpty(beforeClaude)) await claude(admin, member, docs6, ents4, ctl);
    else for (const id of ["K1", "K2", "K3", "K4"]) skipped(id, `INCONCLUSIVE, not run: ${describeAmbiguity(beforeClaude)}; the memory tool searches all active memory, so an answer could retrieve or cite data outside this run's workspace`);

    // ---- L. Knowledge approval workflow
    await knowledge(admin, member, A, ws, someDoc.id as string, byName(await entsOf(), "Send Halcyon checklist"), byName(await entsOf(), "Confirm warehouse slot"));

    // ---- P. state for a fresh process
    state.docs = (await docsOf()).map((d) => ({ source_id: String(d.source_id), content_hash: String(d.content_hash), segments: ((d.segments ?? []) as unknown[]).length }));
    state.entities = (await entsOf()).length;
    const saved = persistState(state);
    if (saved) console.log(`  fresh-process check: node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-memory-supabase.live-dev.script.ts --verify-persisted "${stateFile}"`);
    check("P1", saved, saved ? undefined : "could not write the state file");
  } finally {
    // The same cleanup the signal handlers and --cleanup use: release this run's locks, archive exactly this run's three synthetic sources.
    await cleanup();
  }
}

// ------------------------------------------------------------------------------------------------ K: Claude
const diag = (a: { text: string; sections: string; cites: string[] }): string => `chars=${a.text.length} cites=${a.cites.length} excerpt="${sanitizeDiag(a.text)}" labels="${sanitizeDiag(a.sections, 80)}"`;
// TRACE-HELPERS-BEGIN (pure; the local test evaluates exactly this block)
/** What the model passed to a memory tool: query (redacted, short), entity_type, limit, plus the NAMES of any other keys. Never the full source text. */
function describeToolInput(input: unknown): string {
  const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const one = (k: string, max: number) => `${k}=${k in o && o[k] !== undefined ? sanitizeDiag(String(o[k]), max) : "-"}`;
  const extra = Object.keys(o).filter((k) => k !== "query" && k !== "entity_type" && k !== "limit");
  return `input{${one("query", 60)}, ${one("entity_type", 30)}, ${one("limit", 6)}${extra.length ? `, other_keys=[${extra.join(",").slice(0, 60)}]` : ""}}`;
}
/** What the adapter's findEntities received and returned: the arguments, the filter shape it builds from them, and the row count (or that it threw; the error text is dropped). */
function describeAdapterCall(q: { entity_type?: string; query?: string; limit: number; source_doc_id?: string; include_rejected?: boolean }, outcome: number | unknown): string {
  const words = searchWords(q.query);
  const filter = [
    "doc.archived=eq.false",
    q.entity_type ? `entity_type=eq.${sanitizeDiag(q.entity_type, 30)}` : "entity_type=-",
    q.source_doc_id ? "source_doc_id=eq.<id>" : "source_doc_id=-",
    q.include_rejected ? "review_status=any" : "review_status=neq.rejected",
    words.length ? `or=ilike(name,description,owner,team)x${words.length}word(s)` : "or=-",
    `order=extracted_at.desc,id.asc`,
    words.length < 2 ? `read=single,limit ${Math.min(q.limit, 200)}` : "read=paged,200/page",
  ].join("; ");
  const result = typeof outcome === "number" ? `${outcome} row(s)` : "threw (error text withheld)";
  return `adapter.findEntities{${[`query_words=[${words.map((w) => sanitizeDiag(w, 30)).join(",")}]`, `entity_type=${q.entity_type ?? "-"}`, `limit=${q.limit}`, `source_doc=${q.source_doc_id ? "yes" : "no"}`, `include_rejected=${!!q.include_rejected}`].join(", ")}} filter{${filter}} -> ${result}`;
}
/** Ids of the evidence segments that were really delivered to the model so far: the "M1.S2 (kind) ..." lines of the tool results in the conversation. Ids only. */
function deliveredIds(messages: unknown): string[] {
  return [...new Set(JSON.stringify(messages).match(/\bM\d+\.S\d+(?= \()/g) ?? [])];
}
/**
 * What one submit_answer contained, WITHOUT its text: per item the number of factual sentences (counted exactly as the agent counts them) and each citation id
 * with whether it was delivered; then the validation branch that rule order (tool-agent.ts finalizeItems: marker, several factual sentences, invalid or
 * undelivered cite, factual item without a cite, no cited factual item) predicts. The branch is PREDICTED from the submission; the agent's own outcome is
 * logged next to it, and a disagreement would show here. The schema, injection and link checks are not mirrored.
 */
function describeSubmission(input: unknown, delivered: ReadonlySet<string>, ctx: { queryWords: readonly string[]; recordTerms: readonly string[] } = { queryWords: [], recordTerms: [] }): string {
  const raw = typeof input === "object" && input !== null ? (input as { items?: unknown }).items : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return "items=? (not an array: the agent declines it as 'empty')";
  const parts: string[] = [];
  const flags: string[] = [];
  let branch = "";
  let used = 0;
  let citedFactual = 0;
  raw.forEach((it, idx) => {
    const o = typeof it === "object" && it !== null ? (it as { text?: unknown; cites?: unknown }) : {};
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const cites = Array.isArray(o.cites) ? [...new Set((o.cites as unknown[]).map((c) => String(c).trim()))] : [];
    const factual = text.split(/(?<=[.!?])\s+/).filter((x) => { const b = x.trim(); return b.length >= 25 && !isCoverageStatement(b) && !(b.length <= 120 && b.endsWith(":")); }).length;
    const marker = /\[[^\]\n]{0,40}\bM\d+\.S\d+[^\]\n]{0,40}\]/.test(text);
    const shown = cites.map((c) => `${sanitizeDiag(c, 12)}:${/^M\d+\.S\d+$/.test(c) ? (delivered.has(c) ? "delivered" : "NOT_DELIVERED") : "INVALID_FORMAT"}`);
    parts.push(`item${idx + 1}{chars=${text.length}, factual_sentences=${factual}, marker_in_text=${marker}, cites=[${shown.join(",")}]}`);
    // An item that has a factual sentence and no cite is the kind the validator rejects for a missing citation (whichever branch fires first): classify it, never quote it.
    if (factual >= 1 && cites.length === 0 && flags.length < 10) flags.push(uncitedFlags(text, factual, cites.length, idx + 1, ctx));
    if (branch) return;
    if (marker) { branch = `marker_in_text (item ${idx + 1})`; return; }
    if (factual > 1) { branch = `several_factual_sentences_in_one_item (item ${idx + 1})`; return; }
    const bad = cites.find((c) => !/^M\d+\.S\d+$/.test(c) || !delivered.has(c));
    if (bad !== undefined) { branch = `invented_or_undelivered_cite (item ${idx + 1})`; return; }
    if (factual === 1) { if (cites.length === 0) { branch = `factual_item_without_cite (item ${idx + 1})`; return; } citedFactual += 1; }
    used += cites.length;
  });
  if (!branch && (used === 0 || citedFactual === 0)) branch = "no_cited_factual_item";
  return `items=${raw.length} delivered_ids=[${[...delivered].join(",")}] ${parts.join(" ")}${flags.length ? ` ${flags.join(" ")}` : ""} predicted_branch=${branch || "none (the checks above would accept it)"}`;
}
/**
 * Category flags for ONE rejected-for-missing-citation item, from fixed word lists only (no model, no text kept). Numbers and booleans are all that leave this
 * function. The input is looked at only up to 2000 characters, so a very long item costs a bounded amount of work.
 * `queryWords`: the words of the searches the model made. `recordTerms`: the owner / team values of the records delivered (compared, never printed).
 */
function uncitedFlags(text: string, factual: number, citeCount: number, index: number, ctx: { queryWords: readonly string[]; recordTerms: readonly string[] }): string {
  const t = text.slice(0, 2000);
  const lower = t.toLowerCase();
  const has = (words: readonly string[]) => words.some((w) => w.length >= 3 && lower.includes(w.toLowerCase()));
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s/.test(t);
  const negation = /\b(?:no|not|none|nothing|nobody|never|cannot|without|unknown|missing)\b|n['’]t\b/i.test(t);
  const status = /\b(?:propos\w*|review\w*|unreviewed|approv\w*|status|verified|draft|confirmed)\b/i.test(t);
  const ownerTeam = /\b(?:owner|owners|owned|owns|assign\w*|team|teams|responsible|lead)\b/i.test(t) || has(ctx.recordTerms);
  const due = /\b(?:due|deadline|deadlines|date|dated|eta|tomorrow|today|week|weeks|month|schedule\w*|by (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i.test(t);
  return `uncited_item{index=${index}, chars=${text.length}, bullet=${bullet}, negation=${negation}, query_term=${has(ctx.queryWords)}, review_status=${status}, owner_team=${ownerTeam}, due_date=${due}, factual=${factual > 0}(sentences=${factual}), zero_cites=${citeCount === 0}}`;
}
/** The words of the searches the model made, read from its own tool calls in the conversation (words only, from the same tokenizer the search uses). */
function queryWordsOf(messages: unknown): string[] {
  const words: string[] = [];
  for (const m of Array.isArray(messages) ? (messages as { role?: string; content?: unknown }[]) : []) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type?: string; input?: { query?: unknown } }[]) {
      if (b.type === "tool_use" && b.input && typeof b.input.query === "string") words.push(...searchWords(b.input.query));
    }
  }
  return [...new Set(words)];
}
/** The owner and team values of the records that were delivered (read out of the tool results; used only to recognise a mention, never printed). */
function recordTermsOf(messages: unknown): string[] {
  const out = new Set<string>();
  for (const m of JSON.stringify(messages).matchAll(/\\"(?:owner|team)\\":\\"([^\\"]{1,60})\\"/g)) out.add(m[1]!);
  return [...out];
}
/** One line per model turn: the round, the tools it named, and for a final submit_answer the content-free breakdown above. */
function describeRound(round: number, messages: unknown, blocks: { type: string; name?: string; input?: unknown }[], forced: boolean): string {
  const uses = blocks.filter((b) => b.type === "tool_use");
  const head = `round ${round}${forced ? " (final turn: submit_answer forced)" : ""}: tools=[${uses.map((u) => u.name).join(",") || "none"}]`;
  if (uses.length === 0) return `${head} plain_text_only (no tool call, no submit_answer)`;
  const submit = uses.find((u) => u.name === "submit_answer");
  if (!submit) return `${head} final_submit=no`;
  return `${head} final_submit=yes alone=${uses.length === 1} ${describeSubmission(submit.input, new Set(deliveredIds(messages)), { queryWords: queryWordsOf(messages), recordTerms: recordTermsOf(messages) })}`;
}
/**
 * The JSONL line that keeps a K1/K2 diagnostic. The console detail also carries `excerpt="..."` (a short piece of the ANSWER) and `labels="..."`; those are never kept.
 * Only an allow-list survives: the counts at the head and the `trace=[...]` (tool calls, search words, record counts, round and category flags), then sanitizeDiag
 * and a hard length bound. Returns null when there is nothing to keep.
 */
function detailLine(id: string, status: string, detail: string | undefined, at: string): string | null {
  if (!detail) return null;
  const head: string[] = [];
  for (const re of [/repository records read=\d+/, /\bchars=\d+/, /\bcites=\d+/, /\bvalid=\d+/, /\bexpected_cites_present=(?:true|false)/]) {
    const m = re.exec(detail.slice(0, detail.indexOf("excerpt=") >= 0 ? detail.indexOf("excerpt=") : detail.length));
    if (m) head.push(m[0]);
  }
  const t = detail.lastIndexOf("trace=[");
  const trace = t >= 0 ? detail.slice(t) : "";
  const kept = sanitizeDiag(`${head.join(" ")} ${trace}`, 4000);
  if (!kept) return null;
  return JSON.stringify({ type: "detail", at, id, status, detail: kept });
}
// TRACE-HELPERS-END

/** Wraps the real transport so every model turn is described (content-free) in the trace; the turn itself is returned untouched. */
function loggingTransport(inner: ToolTransport, sink: string[]): ToolTransport {
  return async (req) => {
    const turn = await inner(req);
    const round = Math.floor(req.messages.length / 2) + 1; // user, assistant, user, ...: the agent's own round counter, derived statelessly
    sink.push(describeRound(round, req.messages, turn.blocks as { type: string; name?: string; input?: unknown }[], !!req.toolChoice));
    return turn;
  };
}

async function claude(admin: Session, member: Session | null, docs: { id: unknown; segments: unknown }[], ents: OrgEntity[], ctl: Control, k12?: { expectCites: string[] }) {
  process.env.BROKO_AI_TOOLS = "1"; process.env.BROKO_AI_CHAT = "llm";
  const tools = chatToolAgent(process.env);
  const transport = createToolTransport(loadAiBrainConfig(process.env), { timeoutMs: 60_000 });
  if (!tools || !transport) { for (const id of k12 ? ["K1", "K2"] : ["K1", "K2", "K3", "K4"]) blocked(id, "no model key, or the tool path is not enabled (ANTHROPIC_API_KEY)"); return; }
  if (k12) info(`claude model=${loadAiBrainConfig(process.env).llm.model}`);
  void ctl; void ents;
  const trace: string[] = [];
  // The SAME agent code and wiring the application builds (chat-model.ts: createToolAgent over a 20 s transport with an in-memory 30/hour limiter, then the relationship-tool gate),
  // with the transport wrapped only to describe each turn. Nothing it returns or accepts differs.
  const innerTransport = createToolTransport(loadAiBrainConfig(process.env), { timeoutMs: 20_000 });
  const diagAgent = gateRelationshipTool(createToolAgent({ transport: loggingTransport(innerTransport ?? transport, trace), limiter: createMemoryRateLimiter({ maxCalls: 30, windowMs: 3_600_000 }) }), process.env);
  const validIds = new Set(docs.flatMap((d) => ((d.segments ?? []) as { id: string }[]).map((s) => s.id)));
  const reads = { admin: 0, member: 0 };
  const repoOf = (u: Session, key: "admin" | "member") => async (): Promise<Repo> => {
    const a = createSupabaseOrgMemory(u.db, u.profile);
    return { ...fakeRepo({}).repo, orgMemory: { ...a, reader: { ...a.reader,
      findEntities: async (q) => {
        // Trace only: what the adapter was actually handed and what it returned (or that it threw). Behaviour is unchanged.
        try { const r = await a.reader.findEntities(q); reads[key] += r.length; trace.push(describeAdapterCall(q, r.length)); return r; }
        catch (e) { trace.push(describeAdapterCall(q, e)); throw e; }
      },
      getDocument: async (id) => { const r = await a.reader.getDocument(id); if (r) reads[key] += 1; return r; } } } };
  };
  // Diagnostic only (changes no behaviour): what the model asked the memory tools for, how many records came back, and why the agent answered or declined.
  // Content-free apart from a short redacted query (the model's own wording of a synthetic question) and fixed reason codes.
  const spy = { async run(req: Parameters<typeof diagAgent.run>[0]) {
    const o = await diagAgent.run({ ...req, run: async (id, input) => {
      const r = await req.run(id, input);
      trace.push(`${id} ${describeToolInput(input)} -> ${r.ok ? `ok ${r.records.length} record(s)` : `failed ${r.reason}`}`);
      return r;
    } });
    trace.push(o.kind === "answered" ? "agent=answered" : `agent=declined:${o.reason} (tool calls ${o.stats.calls})`);
    return o;
  } };
  const traced = () => `trace=[${trace.splice(0).join("; ") || "no tool call, no agent outcome"}]`;
  const ask = (u: Session, key: "admin" | "member", q: string) => handleChat({ user: u.profile, backendKind: "supabase", repoFor: repoOf(u, key), toolAgent: spy, timeZone: "UTC" }, q);
  const flat = (res: Awaited<ReturnType<typeof ask>>) => res.ok ? { text: res.reply.text, sections: res.reply.sections.flatMap((s) => [s.heading ?? "", ...(s.items ?? []).map((i) => i.text)]).join(" | "), cites: res.reply.sections.flatMap((s) => s.items ?? []).flatMap((i) => i.cite ?? []) } : null;

  // K1/K2 ask about the warehouse slot: by this point it is the record that SURVIVES as PROPOSED (the Pune decision was rejected in step I4 on purpose, and
  // rejected records are never retrieved; the checklist task was approved). K3 uses the checklist task, which exists and is reviewed.
  reads.admin = 0;
  const q1 = flat(await ask(admin, "admin", "what do our stored notes say about the Halcyon warehouse slot"));
  const t1 = traced();
  const k1Grounded = !k12 || (!!q1 && /warehouse/i.test(`${q1.text} ${q1.sections}`)); // K-only: the answer is about the expected record
  check("K1", !!q1 && reads.admin > 0 && /stored Notion memory/.test(q1.sections) && k1Grounded, q1 ? `repository records read=${reads.admin}; ${diag(q1)}; ${t1}` : "chat failed");
  // K-only: the citations must include the expected evidence segment, and the answer must not state a number or amount (the fixture has none; a run id in a title is stripped).
  const k2Strict = !k12 || (!!q1 && k12.expectCites.every((c) => q1.cites.includes(c)) && !/[$€£]|\b\d{3,}\b/.test(q1.text.replace(/\b\d{10,}(?:-[0-9a-f]{4,})?\b/gi, " ")));
  check("K2", !!q1 && q1.cites.length > 0 && q1.cites.every((c) => validIds.has(c)) && /proposed|not (yet )?reviewed|unreviewed/i.test(`${q1.sections} ${q1.text}`) && k2Strict, q1 ? `cites=${q1.cites.length} valid=${q1.cites.filter((c) => validIds.has(c)).length}${k12 ? ` expected_cites_present=${k12.expectCites.every((c) => q1.cites.includes(c))}` : ""}; ${diag(q1)}; ${t1}` : "chat failed");
  if (k12) return; // K-only mode stops here: no K3, no member question
  const readsBefore2 = reads.admin;
  const q2 = flat(await ask(admin, "admin", "wat is the budgt for halcyon launch n who approved it??"));
  const t2 = traced();
  const reads2 = reads.admin - readsBefore2;
  const q3 = flat(await ask(admin, "admin", "who sends the halcyon checklist"));
  const t3 = traced();
  // A long digit run in an answer is most likely the run id inside a page title, not an invented figure: strip it before looking for numbers.
  const stripRun = (t: string) => t.replace(/\b\d{10,}(?:-[0-9a-f]{4,})?\b/gi, " ");
  const inventedNumber = !!q2 && /[$€£]|\b\d{3,}\b/.test(stripRun(q2.text));
  const q3ok = !!q3 && /Priya/.test(`${q3.text} ${q3.sections}`) && !/Zed|March 3/.test(`${q3.text} ${q3.sections}`);
  check("K3", !!q2 && !inventedNumber && !/Zed|March 3/.test(q2.text) && q3ok, q2 ? `invented_number=${inventedNumber}; unsupported_in_q2=${/Zed|March 3/.test(q2.text)}; q3_names_owner=${!!q3 && /Priya/.test(`${q3.text} ${q3.sections}`)}; q3_unsupported=${!!q3 && /Zed|March 3/.test(`${q3.text} ${q3.sections}`)}; q2_records_read=${reads2}; q2: ${diag(q2)}; q2 ${t2}; q3: ${q3 ? diag(q3) : "chat failed"}; q3 ${t3}` : "chat failed");
  if (!member) return;
  reads.member = 0;
  const m = flat(await ask(member, "member", "what do our stored notes say about the Halcyon marketplace launch decision"));
  const mText = m ? `${m.text} ${m.sections}` : "";
  check("K4", reads.member === 0 && !/Halcyon|Pune|Priya|Dana/.test(mText), `member repository records read=${reads.member}; ${traced()}`);
}

// ------------------------------------------------------------------------------------------------ L: Knowledge
async function knowledge(admin: Session, member: Session, A: ReturnType<typeof createSupabaseOrgMemory>, ws: string, docId: string, task: OrgEntity | undefined, warehouse: OrgEntity | undefined) {
  void ws; void docId;
  if (!task || !warehouse) { for (const id of ["L1", "L2", "L3"]) blocked(id, "synthetic records not available"); return; }
  const kRepo = createSupabaseKnowledgeRepo(admin.db, admin.profile);
  const mk = async (e: OrgEntity) => { if (e.review_status === "proposed") await A.reader.review(e.id, "approve", "live-test approval"); return proposeToKnowledge({ reader: A.reader, knowledge: kRepo }, e.id); };
  const p1 = await mk(task);
  let itemId = "";
  if (p1.ok) {
    itemId = p1.knowledge_id;
    const item = await admin.db.from("knowledge_items").select("id,status,source_ref").eq("id", itemId).maybeSingle();
    const ent = await A.reader.getEntity(task.id);
    check("L1", item.data?.status === "proposed" && ent?.review_status === "promotion_proposed" && ent.knowledge_item_id === itemId && ent.evidence.length > 0 && /Halcyon/.test(String(item.data?.source_ref)), p1.ok ? "proposed" : "");
  } else check("L1", false, p1.reason);
  // L2 needs the approve/expire cycle on a synthetic item; it is only run when no real account could see it
  const others = await admin.db.from("profiles").select("id", { count: "exact", head: true }).not("id", "in", `(${admin.profile.id},${member.profile.id})`);
  const presence = others.error || others.count === null ? { ok: false, message: "could not count other accounts" } : presenceVerdict(others.count, process.env.KNOWLEDGE_LIVE_ALLOW_OTHER_USERS);
  if (!itemId) blocked("L2", "no Knowledge proposal exists");
  else if (!presence.ok) blocked("L2", `approval is not exercised: ${presence.message}`);
  else {
    const mApprove = await member.db.rpc("knowledge_review", { p_id: itemId, p_action: "approve", p_note: null });
    const still = await admin.db.from("knowledge_items").select("status").eq("id", itemId).maybeSingle();
    const ok = await admin.db.rpc("knowledge_review", { p_id: itemId, p_action: "approve", p_note: "live-test" });
    const approved = await admin.db.from("knowledge_items").select("status").eq("id", itemId).maybeSingle();
    const exp = await admin.db.rpc("knowledge_review", { p_id: itemId, p_action: "expire", p_note: "live-test cleanup" });
    check("L2", mApprove.error?.code === "42501" && still.data?.status === "proposed" && !ok.error && approved.data?.status === "approved" && !exp.error, `member=${mApprove.error?.code ?? "allowed"} approve=${why(ok.error)} expire=${why(exp.error)}`);
  }
  const p2 = await mk(warehouse);
  if (!p2.ok) { check("L3", false, p2.reason); return; }
  const rej = await admin.db.rpc("knowledge_review", { p_id: p2.knowledge_id, p_action: "reject", p_note: "live-test rejection" });
  const after = await A.reader.getEntity(warehouse.id);
  const doc = after ? await A.reader.getDocument(after.source_doc_id) : null;
  check("L3", !rej.error && !!after && !!doc && after.evidence.length > 0, why(rej.error));
}

// ------------------------------------------------------------------------------------------------ fresh-process re-read
async function verifyPersisted(file: string) {
  guard();
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  const admin = await signIn("PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  const r = await admin.db.from("org_source_docs").select("id,source_id,content_hash,extracted_hash,segments,workspace_id").eq("workspace_id", state.ws);
  const rows = r.data ?? [];
  const docsOk = !r.error && rows.length === state.docs.length && state.docs.every((d) => { const row = rows.find((x) => x.source_id === d.source_id); return !!row && row.content_hash === d.content_hash && HEX64.test(String(row.content_hash)) && row.extracted_hash === row.content_hash && ((row.segments ?? []) as unknown[]).length === d.segments; });
  const A = createSupabaseOrgMemory(admin.db, admin.profile);
  let ents = 0; let evidenceOk = true;
  for (const row of rows) {
    const segIds = new Set(((row.segments ?? []) as { id: string }[]).map((s) => s.id));
    const es = await A.reader.findEntities({ source_doc_id: String(row.id), include_rejected: true, limit: 50 }).catch(() => []);
    ents += es.length; if (!es.every((e) => e.evidence.length > 0 && e.evidence.every((id) => segIds.has(id)))) evidenceOk = false;
  }
  // archived sources are hidden from the reader by design, so a fresh process sees 0 records through the reader after cleanup; count them directly instead
  const direct = await admin.db.from("org_entities").select("id", { count: "exact", head: true }).in("source_doc_id", rows.map((x) => String(x.id)));
  console.log(`${docsOk ? "PASS   " : "FAIL   "} fresh process: ${rows.length}/${state.docs.length} documents present with identical hashes, hashes valid, extracted = current`);
  console.log(`${direct.count === state.entities ? "PASS   " : "FAIL   "} fresh process: ${direct.count ?? "?"}/${state.entities} L1 records present (reader sees ${ents}: archived sources are hidden from retrieval)`);
  console.log(`${evidenceOk ? "PASS   " : "FAIL   "} fresh process: evidence references that the reader can see resolve to stored segments`);
  if (!docsOk || direct.count !== state.entities || !evidenceOk) process.exitCode = 1;
}

// ------------------------------------------------------------------------------------------------ independent recovery
/** --cleanup <state-file>: the recovery path for a run that was killed. Signs in as admin and runs the same bounded cleanup. Nothing else is read or written. */
async function cleanupMode(file: string) {
  let parsed: State;
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as State; } catch { throw new Abort("the state file could not be read"); }
  const problems = cleanupProblems(parsed);
  if (problems.length) throw new Abort(`REFUSED: ${problems.join("; ")} (cleanup acts only on a live-test run's own workspace and source ids)`);
  guard();
  const admin = await signIn("PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  if (admin.profile.role !== "admin") throw new Abort("the signed-in account is not an administrator");
  const r = await cleanupState(createSupabaseOrgMemory(admin.db, admin.profile), parsed);
  console.log(`CLEANUP  workspace ${parsed.ws}: ${r.archived}/${parsed.sources.length} sources archived, ${r.released} lock(s) released. Records are hidden from retrieval, not deleted. Pre-existing records were not touched.`);
}

// ------------------------------------------------------------------------------------------------ --k-only: ONLY K1 and K2, one synthetic source
const planOf = (kOnly: boolean) => PLAN.filter((s) => (kOnly ? (KONLY_IDS as readonly string[]).includes(s.id) : s.group !== "KO K-only"));

function dryRunKOnly() {
  console.log("\n=== K-ONLY live test plan (DRY RUN: nothing is contacted or written) ===");
  for (const s of planOf(true)) console.log(`  ${s.id.padEnd(3)} ${s.writes ? "WRITES" : "read  "} ${s.text}`);
  const sample = newRunId();
  console.log(`\n=== Planned names (a real run generates its own run id; this one is only an example) ===\n  workspace : ${KONLY_WS_PREFIX}${sample}\n  source id : ${sample}-k1   (the only source; the ingestion is fed by an in-process fake Notion connector, so no real Notion page is read or changed)`);
  console.log(`\n=== Database objects the run may create or update (all through the existing admin session and the existing writer functions) ===
  org_source_docs   +1 row   workspace live-konly-<runId>, source <runId>-k1 (org_memory_upsert_doc); later UPDATED to archived=true (org_memory_archive_doc) and marked extracted
  org_entities      +1 row   'Confirm warehouse slot', review_status proposed (org_memory_upsert_entity); never reviewed, never promoted
  org_ingest_runs   +1 row   counts only (org_memory_run_start / org_memory_run_finish); the single-run lock is taken and released
  NOT touched       org_relationships, org_relationship_events, org_entity_events, knowledge_items, profiles (read only), any pre-existing row, any migration, any setting`);
  console.log(`\n=== Exact cleanup scope ===\n  only the single source '<runId>-k1' in workspace '${KONLY_WS_PREFIX}<runId>' is archived (hidden from retrieval); only the run lock this run recorded is released. A state file that does not match this scheme exactly is refused. Rows are NOT deleted; the residual rows above are listed at the end. A purge needs a separate approval.`);
  console.log("\n=== Before any write the run requires ===\n  target guard (exact broko-dev ref, PRECON_LIVE_CONFIRM, linked project, publishable key that is not a secret key), admin sign-in with role admin, a fresh run id and workspace, an empty workspace, an unused source id, no real or other-run active document, ANTHROPIC_API_KEY present. Any failure aborts with exit code 2 before the first write.");
  console.log("\n=== Target guard (local checks only) ===");
  const linked = localLinkedRef();
  console.log(`  approved project ref : ${DEV_REF}\n  locally linked ref   : ${linked === DEV_REF ? "matches" : linked === null ? "not found" : "DOES NOT MATCH"}`);
  for (const k of ["PRECON_LIVE_URL", "PRECON_LIVE_CONFIRM", "PRECON_LIVE_ANON_KEY", "PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD", "ANTHROPIC_API_KEY"]) console.log(`  ${k.padEnd(28)}: ${process.env[k] ? "set" : "NOT SET"}`);
  console.log("  PRECON_LIVE_MEMBER_*        : not used in --k-only mode");
  const problems = targetProblems({ url: process.env.PRECON_LIVE_URL, confirm: process.env.PRECON_LIVE_CONFIRM, key: process.env.PRECON_LIVE_ANON_KEY, linkedRef: linked });
  console.log(problems.length ? `  a live run would be REFUSED now:\n${problems.map((p) => `    - ${p}`).join("\n")}` : "  target guard: passes");
}

/** A hash per table of the rows that existed before the run (ids and review-relevant columns only). Null = could not be read completely, so it cannot prove anything. */
const FP: { table: string; cols: string; scope: "workspace" | "doc" | "all" }[] = [
  { table: "org_source_docs", cols: "id,workspace_id,source_id,content_hash,archived,sync_status,attempts", scope: "workspace" },
  { table: "org_entities", cols: "id,source_doc_id,review_status,stale,knowledge_item_id,name,evidence", scope: "doc" },
  { table: "org_relationships", cols: "id,source_doc_id,review_status,stale,relation_type", scope: "doc" },
  { table: "knowledge_items", cols: "id,status", scope: "all" },
];
async function fingerprint(db: SupabaseClient, ws: string | null, docIds: string[]): Promise<Record<string, { rows: number; hash: string } | null>> {
  const out: Record<string, { rows: number; hash: string } | null> = {};
  for (const t of FP) {
    const rows: unknown[] = []; let ok = true;
    for (let p = 0; p < 4; p++) {
      let q = db.from(t.table).select(t.cols);
      if (t.scope === "workspace" && ws) q = q.neq("workspace_id", ws);
      if (t.scope === "doc" && docIds.length) q = q.not("source_doc_id", "in", `(${docIds.join(",")})`);
      const r = await q.order("id", { ascending: true }).range(p * 500, p * 500 + 499);
      if (r.error) { ok = false; break; }
      rows.push(...(r.data ?? []));
      if ((r.data ?? []).length < 500) break;
      if (p === 3) ok = false; // more than 2000 rows: not read completely
    }
    out[t.table] = ok ? { rows: rows.length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 12) } : null;
  }
  return out;
}
const describeFp = (f: Record<string, { rows: number; hash: string } | null>) => Object.entries(f).map(([t, v]) => `${t}=${v ? `${v.rows} rows` : "unreadable"}`).join(", ");

async function kOnlyRun() {
  const runId = newRunId();
  rlog = openResultsLog(STATE_DIR, runId);
  console.log(`RESULTS LOG       ${rlog.path}`);
  console.log("MODE              --k-only: K1 and K2 only, one synthetic source, no member, no lifecycle, no Knowledge, no relationships");
  guard();
  check("A1", true);
  const admin = await signIn("PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  check("KA1", admin.profile.role === "admin");
  if (admin.profile.role !== "admin") throw new Abort("the signed-in account is not an administrator");

  const ws = `${KONLY_WS_PREFIX}${runId}`;
  const src = `${runId}-k1`;
  const A = createSupabaseOrgMemory(admin.db, admin.profile);
  const state: State = { runId, ws, sources: [src], held: [], docs: [], entities: 0 };
  const stateFile = stateFileOf(runId);

  // ---- preflight: everything that can be checked WITHOUT writing, before the first write
  process.env.BROKO_AI_TOOLS = "1"; process.env.BROKO_AI_CHAT = "llm";
  const claudeReady = !!chatToolAgent(process.env) && !!createToolTransport(loadAiBrainConfig(process.env), { timeoutMs: 60_000 });
  const wsDocs = await admin.db.from("org_source_docs").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
  const srcDocs = await admin.db.from("org_source_docs").select("id", { count: "exact", head: true }).eq("source_id", src);
  const amb = await ambiguity(admin.db, ws);
  const before = await fingerprint(admin.db, ws, []);
  const preflightOk = claudeReady && !wsDocs.error && wsDocs.count === 0 && !srcDocs.error && srcDocs.count === 0 && onlyIfEmpty(amb);
  check("KA2", preflightOk, `claude_key=${claudeReady} workspace_docs=${wsDocs.error ? "unknown" : wsDocs.count} source_id_uses=${srcDocs.error ? "unknown" : srcDocs.count}; ${describeAmbiguity(amb)}; before-fingerprint: ${describeFp(before)}`);
  if (!preflightOk) throw new Abort("preflight failed; NO write was made");

  // ---- from here on cleanup is armed: the recovery state is written first, then the first remote write
  console.log(persistState(state) ? `STATE FILE        ${stateFile}\n  recovery if this run is killed: node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-memory-supabase.live-dev.script.ts --cleanup "${stateFile}"` : "WARNING: could not write the recovery state file");
  let cleanupDone: Promise<void> | null = null;
  const cleanup = () => (cleanupDone ??= cleanupState(A, state).then((r) => info(r.refused.length ? `cleanup REFUSED: ${r.refused.join("; ")}` : `cleanup: ${r.archived}/${state.sources.length} synthetic source archived, ${r.released} lock(s) released; workspace ${ws}`)));
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
    process.on(sig, () => { if (interrupted) return; interrupted = true; console.error(`${sig} received: stopping at the next step and cleaning up`); setTimeout(() => void cleanup(), 90_000).unref(); });
  }
  const runIds: string[] = [];
  const pages = new Map<string, Page>([[src, { title: `Halcyon logistics ${runId}`, edited: "2026-11-01T11:00:00.000Z", lines: ["Dana from the Operations team will confirm the warehouse slot."] }]]);
  const ctl: Control = { listFail: false, failIds: new Set(), gate: null, reads: 0 };
  let docs: { id: unknown; segments: unknown; archived?: unknown; access_scope?: unknown; content_hash?: unknown }[] = [];
  try {
    const r1 = await handleIngest({
      user: admin.profile, backendKind: "supabase",
      // Records the run id (so cleanup can release exactly this lock); changes no behaviour.
      repoFor: async () => { const a = createSupabaseOrgMemory(admin.db, admin.profile); return { ...fakeRepo({}).repo, orgMemory: { ...a, runs: { ...a.runs, start: async () => { const r = await a.runs.start(); if (r.ok) { runIds.push(r.id); state.held.push(r.id); persistState(state); } return r; } } } }; },
      notion: notionOf(pages, ctl), extractor: fixtureExtractor, workspaceId: ws, log: () => undefined,
    });
    state.held = []; persistState(state); // the service finished (or failed) its own run; nothing is left held
    check("KB1", r1.ok && r1.status === "ok" && r1.report.created === 1 && r1.report.extracted_docs === 1, r1.ok ? JSON.stringify({ status: r1.status, created: r1.report.created, extracted: r1.report.extracted_docs }) : r1.error);
    if (!r1.ok) throw new Abort("ingestion failed; K1/K2 cannot be evaluated");

    const dr = await admin.db.from("org_source_docs").select("id,source_id,workspace_id,content_hash,access_scope,archived,segments").eq("workspace_id", ws);
    if (dr.error) throw new Abort(`read docs: ${why(dr.error)}`);
    docs = dr.data ?? [];
    const ents = docs.length === 1 ? await A.reader.findEntities({ source_doc_id: String(docs[0]!.id), include_rejected: true, limit: 10 }) : [];
    state.entities = ents.length; persistState(state);
    const segs = ((docs[0]?.segments ?? []) as { id: string; text: string }[]);
    const rec = ents[0];
    const cited = rec ? rec.evidence.map((id) => segs.find((s) => s.id === id)?.text ?? "") : [];
    const kb2 = docs.length === 1 && ents.length === 1 && !!rec && rec.name === "Confirm warehouse slot" && rec.review_status === "proposed" && !rec.stale && !rec.knowledge_item_id
      && rec.evidence.length > 0 && cited.every(Boolean) && cited.some((t) => /warehouse slot/i.test(t)) && [rec.owner, rec.team].every((v) => !v || cited.some((t) => t.includes(v)))
      && docs[0]!.archived === false && docs[0]!.access_scope === "admin" && HEX64.test(String(docs[0]!.content_hash));
    check("KB2", kb2, `documents=${docs.length} records=${ents.length}${rec ? ` status=${rec.review_status} evidence=${JSON.stringify(rec.evidence)}` : ""}`);
    if (!kb2 || !rec) throw new Abort("stored fixture is not as expected; K1/K2 would be ambiguous");

    await claude(admin, null, docs, ents, ctl, { expectCites: rec.evidence });
  } finally {
    await cleanup();
    try {
      const d = await admin.db.from("org_source_docs").select("id,source_id,workspace_id,archived").eq("workspace_id", ws);
      const mine = d.data ?? [];
      const archivedOk = !d.error && mine.every((x) => x.archived === true && x.source_id === src && x.workspace_id === ws);
      const runRow = runIds.length ? await admin.db.from("org_ingest_runs").select("id,status,finished_at").in("id", runIds) : null;
      const released = !runRow || (!runRow.error && (runRow.data ?? []).every((x) => !!x.finished_at));
      check("KC1", archivedOk && released && state.held.length === 0, `documents in workspace=${mine.length} archived=${mine.filter((x) => x.archived).length}; run rows finished=${runRow ? (runRow.data ?? []).filter((x) => x.finished_at).length : 0}/${runIds.length}`);
      const ids = mine.map((x) => String(x.id));
      const after = await fingerprint(admin.db, ws, ids);
      const same = Object.keys(before).every((t) => before[t] !== null && after[t] !== null && before[t]!.rows === after[t]!.rows && before[t]!.hash === after[t]!.hash);
      const ownEnts = ids.length ? await admin.db.from("org_entities").select("id", { count: "exact", head: true }).in("source_doc_id", ids) : null;
      check("KC2", same, `before: ${describeFp(before)}; after: ${describeFp(after)}; ${same ? "pre-existing rows identical (fingerprint)" : "MISMATCH or unreadable: do not treat the isolation as proven"}`);
      info(`RESIDUAL synthetic rows (hidden from retrieval, not deleted): org_source_docs=${mine.length} (archived), org_entities=${ownEnts?.count ?? "?"}, org_ingest_runs=${runIds.length}; workspace ${ws}; source ${src}. Removing them needs a separate approval.`);
    } catch (e) {
      if (e instanceof Abort) throw e;
      info("could not verify cleanup (details withheld); run --cleanup with the state file and check the workspace by hand");
      process.exitCode = 1;
    }
  }
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const kOnly = process.argv.includes("--k-only");
  const mode = process.argv.includes("--dry-run") ? "dry" : process.argv.includes("--execute") ? "exec" : process.argv.includes("--verify-persisted") ? "verify" : process.argv.includes("--cleanup") ? "cleanup" : "";
  if (!mode) { console.error("Refusing: pass exactly one of --dry-run, --execute, --verify-persisted <state-file>, --cleanup <state-file>."); process.exitCode = 2; return; }
  try {
    if (kOnly && (mode === "verify" || process.argv.includes("--wait-expiry"))) throw new Abort("--k-only runs only K1 and K2; it cannot be combined with --verify-persisted or --wait-expiry");
    if (mode === "dry") { if (kOnly) dryRunKOnly(); else dryRun(); return; }
    if (mode === "cleanup") { const f = process.argv[process.argv.indexOf("--cleanup") + 1]; if (!f) throw new Abort("--cleanup needs the state file path"); await cleanupMode(f); return; }
    if (mode === "verify") { const f = process.argv[process.argv.indexOf("--verify-persisted") + 1]; if (!f) throw new Abort("--verify-persisted needs the state file path"); await verifyPersisted(f); return; }
    if (kOnly) await kOnlyRun(); else await live();
  } catch (e) {
    if (e instanceof Abort) { console.error(`ABORTED: ${e.message}`); process.exitCode = 2; }
    else { console.error("The live run stopped on an unexpected error (details withheld: an error can echo a source)."); process.exitCode = 1; }
  } finally {
    if (mode === "exec") {
      const planned = planOf(kOnly);
      for (const s of planned) if (!reported.has(s.id)) console.log(`NOT RUN ${s.id.padEnd(3)} ${s.text}`);
      rlog?.finish(planned, reported);
      console.log(`\nSUMMARY  pass=${tally.PASS} fail=${tally.FAIL} blocked=${tally.BLOCKED} skipped_inconclusive=${tally.SKIPPED} not_run=${planned.filter((s) => !reported.has(s.id)).length}`);
      if (tally.FAIL > 0 && !process.exitCode) process.exitCode = 1;
      else if (tally.SKIPPED > 0 && !process.exitCode) process.exitCode = 3;
    }
  }
}
void main();
