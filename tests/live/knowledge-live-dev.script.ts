/**
 * LIVE verification of governed organizational knowledge (migrations 0009 + 0010) against the DEVELOPMENT Supabase project.
 * NOT part of `npm test` (not named *.test.ts; it needs a real project). Every call goes through the real HTTP API as a signed-in
 * user with the publishable (anon) key, so it proves what the database enforces, not what the app intends. No service-role key is
 * read or accepted anywhere. Role-specific assertions use the admin session for admin things and the member session for member things.
 *
 * MODES (exactly one is required; with none the script refuses):
 *   --dry-run                    no network, no credentials needed: prints the plan, the cleanup strategy and the target guard result
 *   --execute                    runs the live suite (writes synthetic rows; see cleanup below)
 *   --print-purge-sql <manifest> prints (never runs) a DELETE script for one run's rows, for a separate, explicit approval
 *
 * Environment (same variables as tests/live/precon-live-dev.script.ts; set in the window that runs it, never in a file):
 *   PRECON_LIVE_URL=https://olngcbgkxbceqpikcyxk.supabase.co   PRECON_LIVE_CONFIRM=broko-dev   PRECON_LIVE_ANON_KEY=<publishable key>
 *   PRECON_LIVE_ADMIN_EMAIL / _PASSWORD and PRECON_LIVE_MEMBER_EMAIL / _PASSWORD  (the existing synthetic dev accounts)
 *   KNOWLEDGE_LIVE_EXPECT_ROWS="0,0,0"  expected counts of knowledge_items,knowledge_events,answer_feedback before the run (default 0,0,0;
 *                                       after a run that is not purged, pass the new numbers or the script aborts BEFORE writing)
 *   KNOWLEDGE_LIVE_EXPECT_AUDIT=121     expected chat_audit row count (default 121); the script never changes it
 *   KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=<N>  OVERRIDE, normally unset. The run counts the accounts besides the two test accounts (count only, no details)
 *                                       and refuses if there are any, because real users could see the synthetic approved items. Set it to the exact
 *                                       observed count to proceed knowingly; a stale or different number is refused.
 *
 * CLEANUP (see CLEANUP_STRATEGY in lib/knowledge-live-plan.ts): the API has no UPDATE/DELETE on these tables by design. Every created row
 * carries this run's unique marker and is listed in a manifest file. At the end (also after a failure) the admin session moves every
 * still-proposed item to rejected and every still-approved item to expired through knowledge_review(), so nothing stays visible to real
 * users. The rows themselves remain; removing them needs --print-purge-sql plus your approval.
 *
 * Exit code: 0 = every executed check passed (BLOCKED checks are listed, not hidden), 1 = a check failed, 2 = refused or aborted before any write.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { knowledgeAdapter, answerKnowledge } from "../../src/lib/ai-brain/chat/knowledge";
import type { BrainChatContext } from "../../src/lib/ai-brain/chat/types";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../../src/lib/backend/supabase/profile";
import { createSupabaseKnowledgeRepo } from "../../src/lib/backend/supabase/knowledge";
import { createSupabasePreconRepo } from "../../src/lib/backend/supabase/precon";
import type { Repo } from "../../src/lib/backend/types";
import { conflictGroups } from "../../src/lib/knowledge/policy";
import type { KnowledgeRepo } from "../../src/lib/knowledge/repo";
import type { Profile } from "../../src/lib/types";
import { openResultsLog, type ResultsLog } from "./lib/results-log";
import { CLEANUP_STRATEGY, DEV_REF, PLAN, PLAN_IDS, markerOf, newRunId, presenceVerdict, purgeSql, safetyExpiry, targetProblems, titleOf, topicOf, wordOf, type Manifest } from "./lib/knowledge-live-plan";

/** Refused or aborted before any write. Reported and turned into exit code 2; never process.exit() (libuv assertion on Windows). */
class Abort extends Error {}
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Abort(`Missing ${k}`); return v; };
const ZERO = "00000000-0000-4000-8000-000000000000";
type Err = { code?: string; message?: string } | null;
const why = (e: Err) => (e ? `${e.code ?? "?"}: ${String(e.message ?? "").slice(0, 80)}` : "no error");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ reporting
type Status = "PASS" | "FAIL" | "BLOCKED";
const reported = new Map<string, { status: Status; name: string }[]>();
/** Results log (see lib/results-log.ts): one line per check, written as each check finishes, next to the manifest. Opened at the start of a live run. */
let rlog: ResultsLog | null = null;
function report(id: string, status: Status, name: string, detail?: string) {
  if (!PLAN_IDS.has(id)) throw new Error(`unplanned check id ${id}`);
  reported.set(id, [...(reported.get(id) ?? []), { status, name }]);
  rlog?.record(id, name, status, status === "FAIL" ? detail : undefined, status === "BLOCKED" ? detail : undefined); // never throws; codes only
  console.log(`${status.padEnd(7)} ${id.padEnd(4)} ${name}${detail ? `  (${detail})` : ""}`);
}
const check = (id: string, name: string, ok: boolean, detail?: string) => report(id, ok ? "PASS" : "FAIL", name, detail);
const blocked = (id: string, name: string, reason: string) => report(id, "BLOCKED", name, reason);
const info = (s: string) => console.log(`INFO            ${s}`);
/** True when the call was refused with one of the expected codes (any error at all if none given). */
const refusedWith = (e: Err, ...codes: string[]) => !!e && (codes.length === 0 || codes.includes(e.code ?? ""));

// ------------------------------------------------------------------------------------------------ dry run
function printPlan(stage: string) {
  console.log(`\n=== Knowledge live test plan (${stage}) ===`);
  let g = "";
  for (const s of PLAN) {
    if (s.group !== g) { g = s.group; console.log(`\n[${g}]`); }
    console.log(`  ${s.id.padEnd(4)} ${s.role.padEnd(13)} ${s.writes ? "WRITES " : "read   "} ${s.text}`);
  }
  console.log("\n=== Cleanup strategy ===");
  CLEANUP_STRATEGY.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
}
function localLinkedRef(): string | null {
  try { return readFileSync(join(process.cwd(), "supabase", ".temp", "project-ref"), "utf8").trim(); } catch { return null; }
}
function dryRun() {
  printPlan("DRY RUN: no network request is made, nothing is written");
  console.log("\n=== Target guard (local checks only) ===");
  const linked = localLinkedRef();
  console.log(`  approved project ref : ${DEV_REF}`);
  console.log(`  locally linked ref   : ${linked === DEV_REF ? "matches" : linked === null ? "not found" : "DOES NOT MATCH (a live run would refuse)"}`);
  for (const k of ["PRECON_LIVE_URL", "PRECON_LIVE_CONFIRM", "PRECON_LIVE_ANON_KEY", "PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD", "PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD"]) {
    console.log(`  ${k.padEnd(28)}: ${process.env[k] ? "set" : "not set"}`);
  }
  const problems = targetProblems({ url: process.env.PRECON_LIVE_URL, confirm: process.env.PRECON_LIVE_CONFIRM, key: process.env.PRECON_LIVE_ANON_KEY, linkedRef: linked });
  console.log(problems.length ? `  a live run would be REFUSED now:\n${problems.map((p) => `    - ${p}`).join("\n")}` : "  target guard: passes");
  console.log(`  other-user override  : ${process.env.KNOWLEDGE_LIVE_ALLOW_OTHER_USERS ? "KNOWLEDGE_LIVE_ALLOW_OTHER_USERS is set (must equal the observed count)" : "not set (a live run refuses if any account besides the two test accounts exists)"}`);
  console.log(`  expected baselines   : knowledge_items,knowledge_events,answer_feedback = ${process.env.KNOWLEDGE_LIVE_EXPECT_ROWS ?? "0,0,0"}; chat_audit = ${process.env.KNOWLEDGE_LIVE_EXPECT_AUDIT ?? "121"}`);
  console.log("\nDry run complete. Nothing was contacted or written.");
}

// ------------------------------------------------------------------------------------------------ sessions
interface Session { db: SupabaseClient; profile: Profile }
let url = "";
let anonKey = "";
async function signIn(emailKey: string, passKey: string): Promise<Session> {
  const db = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.auth.signInWithPassword({ email: need(emailKey), password: need(passKey) });
  if (error) throw new Abort(`Sign-in failed for ${emailKey}`); // the provider message is not echoed
  const { data: u } = await db.auth.getUser();
  if (!u.user) throw new Abort(`No user after sign-in for ${emailKey}.`);
  const { data: row } = await db.from("profiles").select(PROFILE_COLUMNS).eq("id", u.user.id).maybeSingle();
  if (!row) throw new Abort("No profile row for the signed-in user.");
  return { db, profile: toProfile(row as ProfileRow, u.user.email) };
}

// ------------------------------------------------------------------------------------------------ the live run
async function live() {
  rlog = openResultsLog(join(tmpdir(), "broko-knowledge-live"), newRunId());
  console.log(`RESULTS LOG       ${rlog.path}`);
  const linked = localLinkedRef();
  const problems = targetProblems({ url: process.env.PRECON_LIVE_URL, confirm: process.env.PRECON_LIVE_CONFIRM, key: process.env.PRECON_LIVE_ANON_KEY, linkedRef: linked });
  if (problems.length) { check("A1", "target guard", false, problems.join("; ")); throw new Abort(`Refusing to run: ${problems.join("; ")}`); }
  url = need("PRECON_LIVE_URL"); anonKey = need("PRECON_LIVE_ANON_KEY");
  check("A1", "target is exactly broko-dev, confirmed three ways, key is not a secret key", true);

  const admin = await signIn("PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  const member = await signIn("PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD");
  const A = admin.profile.id; const M = member.profile.id;
  const okRoles = admin.profile.role === "admin" && member.profile.role === "member" && A !== M;
  check("A2", "admin and member sessions are separate users with roles admin and member", okRoles);
  if (!okRoles) throw new Abort("Session roles are not as required.");

  // ---- A6: presence. A head-only count of the profiles that are not the two test accounts. No id, name or email is read or printed.
  const others = await admin.db.from("profiles").select("id", { count: "exact", head: true }).not("id", "in", `(${A},${M})`);
  if (others.error || others.count === null) { check("A6", "presence check", false, why(others.error)); throw new Abort("Could not count other accounts; refusing (fail closed)."); }
  const presence = presenceVerdict(others.count, process.env.KNOWLEDGE_LIVE_ALLOW_OTHER_USERS);
  check("A6", "presence check: only the two test accounts exist, or the exact extra count is acknowledged", presence.ok, presence.message);
  if (!presence.ok) throw new Abort(presence.message);

  const memberRepo: KnowledgeRepo = createSupabaseKnowledgeRepo(member.db, member.profile);
  // The adapter only reads ctx.repo.knowledge and ctx.repo.precon; the rest of Repo is not needed and is deliberately absent.
  const memberCtx = (): BrainChatContext => ({ user: member.profile, mode: "live", now: new Date(), repo: { knowledge: memberRepo, precon: createSupabasePreconRepo(member.db, member.profile) } as unknown as Repo });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const corpus = (JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "secret-corpus.json"), "utf8")) as { cases: { name: string; parts: string[]; db: string | null }[] }).cases;

  // ---- A3 / A4: reachability, review function, baselines (no writes)
  const count = async (db: SupabaseClient, table: string) => { const r = await db.from(table).select("id", { count: "exact", head: true }); if (r.error) throw new Abort(`cannot count ${table}: ${why(r.error)}`); return r.count ?? 0; };
  const base = { items: await count(admin.db, "knowledge_items"), events: await count(admin.db, "knowledge_events"), feedback: await count(admin.db, "answer_feedback"), audit: await count(admin.db, "chat_audit") };
  const fnAdmin = await admin.db.rpc("knowledge_review", { p_id: ZERO, p_action: "approve", p_note: null });
  const fnMember = await member.db.rpc("knowledge_review", { p_id: ZERO, p_action: "approve", p_note: null });
  const a3 = fnAdmin.error?.code === "P0002" && fnMember.error?.code === "42501";
  check("A3", "tables reachable; knowledge_review exists and answers admin (P0002) and member (42501) differently", a3, `admin ${why(fnAdmin.error)}; member ${why(fnMember.error)}`);
  const [ei, ee, ef] = (process.env.KNOWLEDGE_LIVE_EXPECT_ROWS ?? "0,0,0").split(",").map((n) => Number(n.trim()));
  const expectAudit = Number(process.env.KNOWLEDGE_LIVE_EXPECT_AUDIT ?? "121");
  const a4 = base.items === ei && base.events === ee && base.feedback === ef && base.audit === expectAudit;
  check("A4", "baselines match expectation", a4, `items=${base.items} events=${base.events} feedback=${base.feedback} chat_audit=${base.audit}; expected ${ei},${ee},${ef} / ${expectAudit}`);

  // ---- A5: 0010. Both probes carry latency_ms = -1, which violates a CHECK that exists since 0008, so NEITHER can store a row. Which
  //      constraint the database names tells us whether the intent value passed (CHECKs are evaluated in name order: intent before latency).
  const probe = (intent: string) => member.db.from("chat_audit").insert({ actor_id: M, intent, outcome: "answered", project_id: null, source_ids: [], record_count: 0, has_evidence: false, used_model: false, latency_ms: -1 });
  const control = await probe("__bogus_intent__");
  const real = await probe("knowledge");
  const stored = (!control.error) || (!real.error);
  const a5 = !stored && String(control.error?.message).includes("chat_audit_intent_check") && String(real.error?.message).includes("chat_audit_latency_ms_check");
  check("A5", "0010 live: 'knowledge' passes the intent CHECK (control probe is stopped by the intent CHECK, real probe only by the later latency CHECK)", a5, stored ? "A ROW WAS STORED" : `control ${why(control.error)}; real ${why(real.error)}`);

  const preOk = a3 && a4 && a5 && !stored;
  if (!preOk) throw new Abort("A precondition failed; nothing was written by this script (A5 probes cannot store rows).");

  // ---- run identity, manifest, cleanup scaffolding
  const runId = newRunId();
  rlog?.link(runId);
  const marker = markerOf(runId);
  const startedMs = Date.now();
  const manifest: Manifest = { runId, startedAt: new Date().toISOString(), target: DEV_REF, items: [], feedback: [] };
  const dir = join(tmpdir(), "broko-knowledge-live"); mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, `${runId}.json`);
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  save();
  info(`run ${runId}; manifest ${manifestPath}`);
  let skewMs = 0; // database clock minus this machine's clock, learned from the first insert
  const dbNow = () => Date.now() + skewMs;

  // ------------------------------------------------------------------------------------------------ helpers (closures over the run)
  function row(label: string, author: string, over: Record<string, unknown> = {}) {
    return { kind: "procedure", scope: "organization", project_id: null, title: titleOf(runId, label), topic: null, author_id: author, source_type: "manual",
      source_ref: marker, supersedes_id: null, expires_at: safetyExpiry(dbNow()), body: `Synthetic live-test text for run ${runId}. It is not real guidance and is never approved for long.`, ...over };
  }
  const COLS = "id, status, author_id, reviewed_by, reviewed_at, review_note, supersedes_id, expires_at, created_at, project_id, topic, title";
  type Item = { id: string; status: string; author_id: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; supersedes_id: string | null; created_at: string; project_id: string | null; title: string };
  /** Inserts one row, records it in the manifest immediately, and never retries. A thrown (non-API) failure is ambiguous: the marker sweep covers it. */
  async function create(s: Session, who: "admin" | "member", label: string, over: Record<string, unknown> = {}): Promise<{ item: Item | null; error: Err }> {
    let r;
    try { r = await s.db.from("knowledge_items").insert(row(label, s.profile.id, over)).select(COLS).single(); } catch (e) { info(`ambiguous insert "${label}": ${String((e as Error).message).slice(0, 60)}; the marker sweep will find it if it was stored`); return { item: null, error: { message: "ambiguous" } }; }
    if (r.error || !r.data) return { item: null, error: r.error };
    const it = r.data as unknown as Item;
    manifest.items.push({ id: it.id, label, author: who }); save();
    if (!skewMs) skewMs = Date.parse(it.created_at) - Date.now();
    return { item: it, error: null };
  }
  /** An insert that is EXPECTED to be refused. If it unexpectedly succeeds, the row still carries this run's marker, so the cleanup sweep finds it and takes it out of circulation (and F2 fails). */
  async function attempt(s: Session, label: string, over: Record<string, unknown>): Promise<Err> {
    return (await s.db.from("knowledge_items").insert({ ...row(label, s.profile.id), ...over })).error;
  }
  const asAdmin = async (id: string): Promise<Item | null> => ((await admin.db.from("knowledge_items").select(COLS).eq("id", id).maybeSingle()).data as unknown as Item | null);
  const events = async (id: string) => ((await admin.db.from("knowledge_events").select("action, actor_id, from_status, to_status, note").eq("item_id", id).order("created_at", { ascending: true })).data ?? []) as { action: string; actor_id: string; from_status: string | null; to_status: string; note: string | null }[];
  const review = (id: string, action: string, note: string | null) => admin.db.rpc("knowledge_review", { p_id: id, p_action: action, p_note: note });
  const current = async () => (await memberRepo.listCurrent()).map((i) => i.id);
  const sees = async (id: string) => (await current()).includes(id);
  const memberRowsOf = async (id: string) => (await member.db.from("knowledge_items").select("id").eq("id", id)).data ?? [];
  const statusOf = async (id: string) => (await asAdmin(id))?.status ?? null;
  /** Eager retirement: expires an approved item of this run through knowledge_review right after its last required assertion. Never throws; final cleanup is the backstop. */
  const retired: string[] = [];
  async function retire(...ids: string[]) {
    for (const id of ids) {
      if ((await statusOf(id)) !== "approved") continue;
      const r = await review(id, "expire", `retired after its last check ${runId}`);
      if (r.error) info(`retire ${id}: ${why(r.error)} (final cleanup handles it)`); else retired.push(id);
    }
  }
  const mustCreate = async (s: Session, who: "admin" | "member", label: string, over: Record<string, unknown> = {}): Promise<Item> => {
    const r = await create(s, who, label, over);
    if (!r.item) throw new Error(`setup insert "${label}" failed: ${why(r.error)}`);
    return r.item;
  };

  // ------------------------------------------------------------------------------------------------ the checks
  async function body() {
    // ================= B. member boundary
    const mine = await mustCreate(member, "member", "member proposal");
    const evMine = await events(mine.id);
    check("B1", "member proposal: proposed, authored by member, unreviewed, one 'submitted' event", mine.status === "proposed" && mine.author_id === M && !mine.reviewed_by && !mine.reviewed_at && evMine.length === 1 && evMine[0].action === "submitted" && evMine[0].actor_id === M, `${mine.status}; ${evMine.map((e) => e.action).join(",")}`);

    const e2 = await attempt(member, "forged status", { status: "approved" });
    check("B2", "member cannot insert status 'approved'", refusedWith(e2, "42501"), why(e2));
    const e3 = await attempt(member, "forged author", { author_id: A });
    check("B3", "member cannot insert as the administrator", refusedWith(e3, "42501"), why(e3));
    const protectedCols: Record<string, unknown> = { reviewed_by: A, reviewed_at: new Date().toISOString(), review_note: "self reviewed", id: "11111111-2222-4333-8444-555555555555", created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z", effective_from: "2020-01-01T00:00:00Z", organization_id: "11111111-2222-4333-8444-555555555555" };
    const colResults: string[] = []; let allRefused = true;
    for (const [col, val] of Object.entries(protectedCols)) { const e = await attempt(member, `forged ${col}`, { [col]: val }); const ok = refusedWith(e, "42501"); allRefused &&= ok; if (!ok) colResults.push(`${col}: ${why(e)}`); }
    check("B4", "member cannot set any protected column", allRefused, colResults.join("; "));
    const e5 = await attempt(member, "forged source type", { source_type: "correction" });
    check("B5", "member cannot pair source_type 'correction' with kind 'procedure'", refusedWith(e5, "23514"), why(e5));

    const actions = await Promise.all(["approve", "reject", "expire"].map((a) => member.db.rpc("knowledge_review", { p_id: mine.id, p_action: a, p_note: "member attempt" })));
    const afterB6 = await asAdmin(mine.id);
    check("B6", "member cannot approve, reject or expire; item unchanged", actions.every((r) => refusedWith(r.error, "42501")) && afterB6?.status === "proposed" && !afterB6.reviewed_by, actions.map((r) => r.error?.code ?? "ok").join(","));
    const up = await member.db.from("knowledge_items").update({ status: "approved" }).eq("id", mine.id);
    const upTitle = await member.db.from("knowledge_items").update({ title: "hacked title" }).eq("id", mine.id);
    const del = await member.db.from("knowledge_items").delete().eq("id", mine.id);
    const afterB7 = await asAdmin(mine.id);
    check("B7", "member cannot UPDATE or DELETE; item unchanged", [up.error, upTitle.error, del.error].every((e) => refusedWith(e, "42501")) && afterB7?.status === "proposed" && afterB7.title === mine.title, [up.error, upTitle.error, del.error].map((e) => e?.code ?? "ok").join(","));
    const evRead = await member.db.from("knowledge_events").select("id").eq("item_id", mine.id);
    const evWrite = await member.db.from("knowledge_events").insert({ item_id: mine.id, actor_id: M, action: "approved", from_status: "proposed", to_status: "approved" });
    const evDel = await member.db.from("knowledge_events").delete().eq("item_id", mine.id);
    check("B8", "member reads no history and cannot write or delete it", (evRead.data ?? []).length === 0 && refusedWith(evWrite.error, "42501") && refusedWith(evDel.error, "42501"), `read ${(evRead.data ?? []).length} rows; ${why(evWrite.error)}; ${why(evDel.error)}`);

    const adminPriv = await mustCreate(admin, "admin", "admin private proposal");
    const byId = await memberRowsOf(adminPriv.id);
    const byMarker = ((await member.db.from("knowledge_items").select("id, title").like("title", `${marker}%`)).data ?? []) as { id: string }[];
    check("B9", "admin's proposal is invisible to the member (by id and by marker search)", byId.length === 0 && !byMarker.some((r) => r.id === adminPriv.id) && byMarker.some((r) => r.id === mine.id), `by id ${byId.length}; marker search ${byMarker.length} rows (own only)`);

    // ================= C. admin lifecycle
    const rejectMe = await mustCreate(member, "member", "member proposal to reject");
    const c3a = await review(rejectMe.id, "reject", null);
    const c3b = await review(rejectMe.id, "reject", "   ");
    check("C3", "reject without a reason is refused (null and blank); item stays proposed", refusedWith(c3a.error, "22023") && refusedWith(c3b.error, "22023") && (await statusOf(rejectMe.id)) === "proposed", `${why(c3a.error)}; ${why(c3b.error)}`);
    const c4 = await review(rejectMe.id, "reject", `reason from ${marker}`);
    const rej = await asAdmin(rejectMe.id); const evRej = await events(rejectMe.id);
    check("C4", "reject with a reason: rejected, reviewer = admin, reason stored, history ends 'rejected', not in retrieval", !c4.error && rej?.status === "rejected" && rej.reviewed_by === A && !!rej.review_note && evRej.map((e) => e.action).join(",") === "submitted,rejected" && !(await sees(rejectMe.id)), why(c4.error));

    const c1 = await review(mine.id, "approve", `approved by live test ${runId}`);
    const apr = await asAdmin(mine.id); const evApr = await events(mine.id);
    check("C1", "admin approves the member's proposal: approved, reviewer = admin, note stored, history submitted,approved", !c1.error && apr?.status === "approved" && apr.reviewed_by === A && !!apr.reviewed_at && !!apr.review_note && evApr.map((e) => e.action).join(",") === "submitted,approved" && evApr[1].actor_id === A, why(c1.error));
    const adapterOut = await knowledgeAdapter.retrieve(memberCtx(), {});
    const adapterSees = (id: string, out: Awaited<ReturnType<typeof knowledgeAdapter.retrieve>>) => out.ok && out.records.some((r) => r.label.includes(marker) && r.label === titleOf(runId, labelOf(id)));
    const labelOf = (id: string) => manifest.items.find((m) => m.id === id)?.label ?? "";
    check("C2", "the approved item is retrievable by the member (repository and adapter)", (await sees(mine.id)) && adapterSees(mine.id, adapterOut), adapterOut.ok ? `${adapterOut.records.length} records visible` : "adapter not ok");

    // B10 / B11 need an approved, a rejected and a proposed member item at the same moment
    const stillProposed = await mustCreate(member, "member", "member still proposed");
    const own = await memberRepo.listMine(); const ownIds = new Set(own.map((i) => i.id));
    check("B10", "member sees own proposed, approved and rejected submissions", [mine.id, rejectMe.id, stillProposed.id].every((id) => ownIds.has(id)) && own.find((i) => i.id === rejectMe.id)?.status === "rejected");
    const cur = new Set(await current()); const out2 = await knowledgeAdapter.retrieve(memberCtx(), {});
    check("B11", "normal retrieval returns the approved item and neither the proposed nor the rejected one", cur.has(mine.id) && !cur.has(stillProposed.id) && !cur.has(rejectMe.id) && !cur.has(adminPriv.id) && out2.ok && !out2.records.some((r) => r.label === titleOf(runId, "member still proposed") || r.label === titleOf(runId, "member proposal to reject")));
    const anonRead = await anon.from("knowledge_items").select("id").limit(1);
    const anonIns = await anon.from("knowledge_items").insert(row("anon", M));
    const anonRpc = await anon.rpc("knowledge_review", { p_id: mine.id, p_action: "expire", p_note: null });
    check("B12", "anon reads nothing, cannot insert and cannot call knowledge_review", (!!anonRead.error || (anonRead.data ?? []).length === 0) && !!anonIns.error && !!anonRpc.error && (await statusOf(mine.id)) === "approved", `${why(anonIns.error)}; ${why(anonRpc.error)}`);

    // C5 invalid transitions (mine is approved, rejectMe is rejected, stillProposed is proposed)
    const t: [string, Promise<{ error: Err }>, string[]][] = [
      ["approve an approved item", Promise.resolve(review(mine.id, "approve", null)), ["55000"]],
      ["reject an approved item", Promise.resolve(review(mine.id, "reject", "x reason")), ["55000"]],
      ["expire a proposed item", Promise.resolve(review(stillProposed.id, "expire", null)), ["55000"]],
      ["approve a rejected item", Promise.resolve(review(rejectMe.id, "approve", null)), ["55000"]],
      ["expire a rejected item", Promise.resolve(review(rejectMe.id, "expire", null)), ["55000"]],
      ["unknown action", Promise.resolve(review(stillProposed.id, "delete", null)), ["22023"]],
      ["unknown item", Promise.resolve(review(ZERO, "approve", null)), ["P0002"]],
      ["note over 500 characters", Promise.resolve(review(stillProposed.id, "approve", "x".repeat(501))), ["22001"]],
    ];
    const bad: string[] = [];
    for (const [name, p, codes] of t) { const r = await p; if (!refusedWith(r.error, ...codes)) bad.push(`${name}: ${why(r.error)}`); }
    check("C5", "all invalid transitions and calls are refused with the expected codes", bad.length === 0 && (await statusOf(stillProposed.id)) === "proposed" && (await statusOf(mine.id)) === "approved", bad.join("; "));
    await retire(mine.id);

    // C6 supersede
    const topicS = topicOf(runId, "sup");
    const oldAdmin = await mustCreate(admin, "admin", "to be replaced", { topic: topicS });
    await review(oldAdmin.id, "approve", "approved as the item to be replaced");
    const repl = await mustCreate(member, "member", "replacement", { supersedes_id: oldAdmin.id, topic: topicS, body: `Replacement synthetic text for run ${runId}, deliberately different.` });
    const stillCurrent = await sees(oldAdmin.id) && !(await sees(repl.id));
    const c6 = await review(repl.id, "approve", "approve replacement");
    const [oldNow, newNow] = [await asAdmin(oldAdmin.id), await asAdmin(repl.id)];
    const [evOld, evNew] = [await events(oldAdmin.id), await events(repl.id)];
    const curAfter = new Set(await current());
    const expireOld = await review(oldAdmin.id, "expire", null);
    check("C6", "approving the replacement supersedes the old item atomically; both events; old excluded, new retrievable; old cannot be expired", stillCurrent && !c6.error && oldNow?.status === "superseded" && newNow?.status === "approved" && evOld.map((e) => e.action).join(",") === "submitted,approved,superseded" && evNew.map((e) => e.action).join(",") === "submitted,approved" && !curAfter.has(oldAdmin.id) && curAfter.has(repl.id) && refusedWith(expireOld.error, "55000"), `${oldNow?.status}/${newNow?.status}; ${why(c6.error)}`);
    await retire(repl.id);
    const c7a = await attempt(member, "replace a proposed item", { supersedes_id: adminPriv.id });
    const c7b = await attempt(member, "replace an unknown item", { supersedes_id: ZERO });
    check("C7", "member cannot name a proposed or unknown item as the one to replace", refusedWith(c7a, "42501") && refusedWith(c7b, "42501"), `${why(c7a)}; ${why(c7b)}`);

    // C8 expire
    const toExpire = await mustCreate(admin, "admin", "to be expired");
    await review(toExpire.id, "approve", "approved to be expired");
    const visibleBefore = await sees(toExpire.id);
    const c8 = await review(toExpire.id, "expire", "expired by live test");
    const exp = await asAdmin(toExpire.id); const evExp = await events(toExpire.id);
    check("C8", "expire: expired, original reviewer kept, event with note, excluded from retrieval", visibleBefore && !c8.error && exp?.status === "expired" && exp.reviewed_by === A && evExp.at(-1)?.action === "expired" && !!evExp.at(-1)?.note && !(await sees(toExpire.id)), why(c8.error));

    // C9 admin self-approval (documented design)
    const self = await mustCreate(admin, "admin", "admin self approval");
    const c9 = await review(self.id, "approve", "self-approved by design");
    const evSelf = await events(self.id);
    check("C9", "DOCUMENTED DESIGN: an admin can approve their own submission; history records the same actor for submitted and approved", !c9.error && evSelf.length === 2 && evSelf[0].actor_id === A && evSelf[1].actor_id === A, "governance decision, not a defect (docs/KNOWLEDGE_MEMORY.md)");
    await retire(self.id);

    // C10 even admin cannot bypass the function
    const adminUp = await admin.db.from("knowledge_items").update({ status: "approved" }).eq("id", stillProposed.id);
    const adminDel = await admin.db.from("knowledge_items").delete().eq("id", stillProposed.id);
    const adminEv = await admin.db.from("knowledge_events").insert({ item_id: stillProposed.id, actor_id: A, action: "approved", from_status: "proposed", to_status: "approved" });
    const adminEvDel = await admin.db.from("knowledge_events").delete().eq("item_id", stillProposed.id);
    const adminFb = await admin.db.from("answer_feedback").update({ rating: "useful" }).eq("id", ZERO);
    check("C10", "admin cannot UPDATE/DELETE items, write events, or update feedback directly; item unchanged", [adminUp.error, adminDel.error, adminEv.error, adminEvDel.error, adminFb.error].every((e) => refusedWith(e, "42501")) && (await statusOf(stillProposed.id)) === "proposed", [adminUp.error, adminDel.error, adminEv.error, adminEvDel.error, adminFb.error].map((e) => e?.code ?? "ok").join(","));

    // ================= D. scope, expiry
    const nearPast = await mustCreate(admin, "admin", "expires very soon", { expires_at: new Date(dbNow() + 6000).toISOString() });
    const nearFuture = await mustCreate(admin, "admin", "expires later", { expires_at: new Date(dbNow() + 45000).toISOString() });
    const d2a = await review(nearFuture.id, "approve", "approved with a near expiry");
    const d2seen = !d2a.error && (await sees(nearFuture.id));
    // D3 conflict, while waiting
    const topicC = topicOf(runId, "conf"); const word = wordOf(runId);
    const c1i = await mustCreate(admin, "admin", `conflict one ${word}`, { topic: topicC, body: `The ${word} rule says use method alpha. Synthetic text for run ${runId}.` });
    const c2i = await mustCreate(admin, "admin", `conflict two ${word}`, { topic: topicC, body: `The ${word} rule says use method beta. Synthetic text for run ${runId}.` });
    await review(c1i.id, "approve", "conflict one"); await review(c2i.id, "approve", "conflict two");
    const items = await memberRepo.listCurrent();
    const groups = conflictGroups(items, new Date());
    const grp = groups.find((g) => g.some((i) => i.id === c1i.id));
    const answer = await answerKnowledge(memberCtx(), `how do we handle the ${word} rule`, { explicit: true });
    const conflictShown = !!answer?.sections.some((s) => (s.heading ?? "").startsWith("Conflicting approved knowledge"));
    check("D3", "two approved items with one topic and different text are reported as a conflict (policy and Brain answer)", !!grp && grp.some((i) => i.id === c2i.id) && conflictShown, `groups=${groups.length}; answer sections=${answer?.sections.length ?? 0}`);
    await retire(c1i.id, c2i.id);
    // D1: wait for the short expiry, then try to approve it
    await sleep(Math.max(0, Date.parse(nearPast.created_at) + 6000 - dbNow()) + 2000);
    const d1 = await review(nearPast.id, "approve", "too late");
    check("D1", "approving a proposal whose expiry has passed is refused", refusedWith(d1.error, "55000") && (await statusOf(nearPast.id)) === "proposed", why(d1.error));
    // D2: wait for the long expiry
    const waitMs = Date.parse(nearFuture.created_at) + 45000 - dbNow() + 2500;
    info(`waiting ${Math.ceil(Math.max(0, waitMs) / 1000)} s for an approved item to pass its expiry`);
    await sleep(Math.max(0, waitMs));
    const gone = !(await sees(nearFuture.id));
    check("D2", "approved item was retrievable, then disappears from retrieval by itself after its expiry", d2seen && gone && (await statusOf(nearFuture.id)) === "approved", d2seen ? "status still 'approved'; excluded by expires_at" : "never became visible");
    await retire(nearFuture.id);
    blocked("D4", "stale-item labelling", "reviewed_at is stamped by the database; it cannot be back-dated without bypassing it. Covered by tests/knowledge.test.ts");

    // D5 constraint matrix (no project needed). Projects discovered read-only below.
    const projAdmin = ((await admin.db.from("precon_projects").select("id, archived_at").limit(100)).data ?? []) as { id: string; archived_at: string | null }[];
    const projMember = new Set((((await member.db.from("precon_projects").select("id").limit(100)).data ?? []) as { id: string }[]).map((p) => p.id));
    const active = projAdmin.find((p) => !p.archived_at && projMember.has(p.id));
    const archived = projAdmin.find((p) => p.archived_at && !projMember.has(p.id));
    info(`projects found read-only: ${projAdmin.length} (active usable: ${active ? "yes" : "no"}, archived hidden from member: ${archived ? "yes" : "no"})`);
    const matrix: [string, Record<string, unknown>, string[]][] = [
      ["project scope without project", { scope: "project", project_id: null }, ["23514", "42501"]],
      ["organization scope with a project", { scope: "organization", project_id: active?.id ?? ZERO }, ["23514", "42501"]],
      ["project_note kind with organization scope", { kind: "project_note", scope: "organization" }, ["23514"]],
      ["topic with uppercase/spaces", { topic: "Bad Topic" }, ["23514"]],
      ["title shorter than 3 characters", { title: "ab" }, ["23514"]],
      ["body longer than 2000 characters", { body: "x".repeat(2001) }, ["23514"]],
      ["body shorter than 10 characters", { body: "short" }, ["23514"]],
      ["unknown project id", { scope: "project", project_id: ZERO }, ["42501", "23503"]],
      ["expiry before it starts", { expires_at: "2000-01-01T00:00:00Z" }, ["23514"]],
    ];
    const bad5: string[] = [];
    for (const [name, over, codes] of matrix) { const e = await attempt(member, `rule ${name}`, over); if (!refusedWith(e, ...codes)) bad5.push(`${name}: ${why(e)}`); }
    check("D5", "database scope/format/length rules refuse every invalid shape", bad5.length === 0, bad5.join("; "));

    if (active) {
      const d6 = await create(member, "member", "active project proposal", { scope: "project", project_id: active.id });
      check("D6", "member can propose knowledge for an active project they can see", !!d6.item && d6.item.status === "proposed" && d6.item.project_id === active.id, why(d6.error));
      const d8i = await mustCreate(admin, "admin", "active project note", { kind: "project_note", scope: "project", project_id: active.id });
      await review(d8i.id, "approve", "approved for the visibility check");
      const seen = new Set(await current()); const ao = await knowledgeAdapter.retrieve(memberCtx(), {});
      check("D8", "approved knowledge for an active project is retrievable by the member (repository and adapter)", seen.has(d8i.id) && ao.ok && ao.records.some((r) => r.label === titleOf(runId, "active project note")));
      await retire(d8i.id);
    } else { blocked("D6", "propose for an active project", "no existing active project is visible; creating one would modify project data"); blocked("D8", "active project knowledge retrieval", "no existing active project"); }
    if (archived) {
      const d7a = await attempt(member, "archived project proposal", { scope: "project", project_id: archived.id });
      const d7i = await mustCreate(admin, "admin", "archived project note", { kind: "project_note", scope: "project", project_id: archived.id });
      await review(d7i.id, "approve", "approved for the isolation check");
      const hiddenFromList = !(await sees(d7i.id)); const hiddenDirect = (await memberRowsOf(d7i.id)).length === 0;
      check("D7", "archived project: member cannot propose for it, and cannot read its approved knowledge", refusedWith(d7a, "42501") && hiddenFromList && hiddenDirect, why(d7a));
      await retire(d7i.id);
    } else blocked("D7", "archived-project isolation", "no existing archived project; archiving a real project is not allowed by this task");

    // ================= E. feedback and audit
    const fbStart = new Date(startedMs - 5000).toISOString();
    const fbGood = await member.db.from("answer_feedback").insert({ actor_id: M, rating: "not_useful", reason: "outdated", intent: "knowledge", source_ids: ["knowledge"] });
    const fbRows = async () => ((await admin.db.from("answer_feedback").select("*").eq("actor_id", M).gte("created_at", fbStart)).data ?? []) as Record<string, unknown>[];
    const afterE1 = await fbRows();
    for (const r of afterE1) if (!manifest.feedback.includes(String(r.id))) manifest.feedback.push(String(r.id));
    save();
    const keys = afterE1[0] ? Object.keys(afterE1[0]).sort().join(",") : "";
    check("E1", "valid metadata-only feedback is stored; the admin reads exactly the metadata columns", !fbGood.error && afterE1.length === 1 && keys === "actor_id,created_at,id,intent,organization_id,rating,reason,source_ids" && afterE1[0].rating === "not_useful" && afterE1[0].organization_id === null, why(fbGood.error));
    const fb = (over: Record<string, unknown>) => member.db.from("answer_feedback").insert({ actor_id: M, rating: "useful", reason: null, intent: null, source_ids: [], ...over });
    const invalid: [string, Err][] = [
      ["bad rating", (await fb({ rating: "meh" })).error],
      ["free-text reason", (await fb({ reason: "the answer quoted the salary list" })).error],
      ["free-text intent", (await fb({ intent: "what is Dana's salary?" })).error],
      ["unknown source id", (await fb({ source_ids: ["my private note"] })).error],
      ["too many source ids", (await fb({ source_ids: Array(14).fill("tasks") })).error],
      ["extra question column", (await fb({ question: "raw question text" })).error],
      ["extra answer column", (await fb({ answer: "raw answer text" })).error],
      ["extra comment column", (await fb({ comment: "free comment" })).error],
      ["forged actor", (await fb({ actor_id: A })).error],
      ["set created_at", (await fb({ created_at: "2020-01-01T00:00:00Z" })).error],
      ["set id", (await fb({ id: "11111111-2222-4333-8444-555555555555" })).error],
      ["set organization_id", (await fb({ organization_id: "11111111-2222-4333-8444-555555555555" })).error],
    ];
    const stray = await fbRows();
    for (const r of stray) if (!manifest.feedback.includes(String(r.id))) manifest.feedback.push(String(r.id));
    save();
    check("E2", "every invalid or forged feedback insert is refused and nothing extra was stored", invalid.every(([, e]) => !!e) && stray.length === 1, invalid.filter(([, e]) => !e).map(([n]) => n).join(", ") || `${stray.length} row stored in total`);
    const fbRead = await member.db.from("answer_feedback").select("id");
    const fbUp = await member.db.from("answer_feedback").update({ rating: "useful" }).eq("id", String(afterE1[0]?.id ?? ZERO));
    const fbDel = await member.db.from("answer_feedback").delete().eq("id", String(afterE1[0]?.id ?? ZERO));
    const fbAnon = await anon.from("answer_feedback").insert({ actor_id: M, rating: "useful" });
    check("E3", "member reads no feedback and cannot update/delete it; anon cannot insert", (fbRead.data ?? []).length === 0 && refusedWith(fbUp.error, "42501") && refusedWith(fbDel.error, "42501") && !!fbAnon.error, `${why(fbUp.error)}; ${why(fbDel.error)}; ${why(fbAnon.error)}`);
    const caRead = await member.db.from("chat_audit").select("id", { count: "exact", head: true });
    const caUp = await member.db.from("chat_audit").update({ outcome: "error" }).eq("id", ZERO);
    const caDel = await member.db.from("chat_audit").delete().eq("id", ZERO);
    const caAnon = await anon.from("chat_audit").select("id").limit(1);
    check("E4", "chat_audit protections hold: member reads 0 rows, cannot update/delete, anon cannot read", !caRead.error && caRead.count === 0 && refusedWith(caUp.error, "42501") && refusedWith(caDel.error, "42501") && (!!caAnon.error || (caAnon.data ?? []).length === 0), `${why(caUp.error)}; ${why(caDel.error)}`);
    blocked("E5", "source_ids 'knowledge' in chat_audit", "the only probe that could prove it live would store a permanent audit row; verified by the read-only catalog audit (supabase/proposed/tests/0009_catalog_audit.proposed.sql)");

    // ================= G. migrations 0011 (replacement guard, content removal) and 0012 (database secret screen).
    // Secret-shaped strings are built from parts here, so no credential-like text exists in this file. They are not real credentials.
    const KEY = ["sk", "-", "LiveTest", "A1b2C3d4E5f6G7"].join("");
    const echoes = (e: Err, text: string) => { const m = String(e?.message ?? ""); return m.includes(text.slice(0, 20)) || m.includes(text.slice(-20)); };
    const screened = (e: Err, id?: string) => refusedWith(e, "23514") && String(e?.message).includes("secret or credential") && (id === undefined || String(e?.message).includes(`(${id})`));
    /** An insert that must be refused by the database secret screen. If it is stored anyway it is recorded and removed from use through knowledge_redact at once. */
    async function secretAttempt(s: Session, who: "admin" | "member", label: string, over: Record<string, unknown>): Promise<{ error: Err; stored: number }> {
      const r = await s.db.from("knowledge_items").insert({ ...row(label, s.profile.id), ...over }).select("id");
      const stored = (r.data ?? []) as { id: string }[];
      for (const x of stored) { manifest.items.push({ id: x.id, label: `UNEXPECTEDLY STORED: ${label}`, author: who }); save(); await admin.db.rpc("knowledge_redact", { p_id: x.id, p_reason: "secret" }); }
      return { error: r.error, stored: stored.length };
    }
    const countMine = async () => (await member.db.from("knowledge_items").select("id", { count: "exact", head: true }).eq("author_id", M)).count ?? -1;

    // G1: replacement must match on topic (0011)
    const topicG = topicOf(runId, "gtopic");
    const gOld = await mustCreate(admin, "admin", "topic guard target", { topic: topicG });
    await review(gOld.id, "approve", "approved as a topic guard target");
    const gPlain = await mustCreate(admin, "admin", "untopiced guard target");
    await review(gPlain.id, "approve", "approved as an untopiced target");
    const before1 = await countMine();
    const g1a = await attempt(member, "different topic", { supersedes_id: gOld.id, topic: topicOf(runId, "gother") });
    const g1b = await attempt(member, "no topic", { supersedes_id: gOld.id, topic: null });
    const g1c = await attempt(member, "topic on an untopiced item", { supersedes_id: gPlain.id, topic: topicG });
    const stored1 = (await countMine()) - before1;
    const g1d = await create(member, "member", "matching topic replacement", { supersedes_id: gOld.id, topic: topicG });
    check("G1", "topic must match to replace: three mismatches refused (42501), nothing stored; the matching topic is accepted", [g1a, g1b, g1c].every((e) => refusedWith(e, "42501")) && stored1 === 0 && !!g1d.item && (await statusOf(gOld.id)) === "approved", `${why(g1a)}; ${why(g1b)}; ${why(g1c)}; stored ${stored1}; matching ${why(g1d.error)}`);
    await retire(gOld.id, gPlain.id); // the org-scope items a real member could read are expired as soon as G1 is done
    // Items that only an administrator needs are put in an ARCHIVED project the member (and therefore any other member) cannot read, so they are never visible to anyone else.
    const iso: Record<string, unknown> = archived ? { kind: "project_note", scope: "project", project_id: archived.id } : {};
    info(archived ? "G6/G10 helper items use an archived project: invisible to every non-administrator" : "no archived project: G6/G10 helper items are organization scope (visible to members while approved, seconds)");
    blocked("G2", "approval-time mismatch refusal (23514)", "a mismatched row cannot be inserted through the API because the insert policy stops it first; covered by the local PGlite test (an owner-inserted row)");

    // G3 / G4 / G5: the database secret screen (0012)
    const failures: string[] = [];
    const before3 = await countMine();
    for (const c of corpus.filter((x) => x.db !== null)) {
      const text = c.parts.join("");
      const r = await secretAttempt(member, "member", `secret ${c.name}`.slice(0, 60), { body: `Synthetic text. ${text} end.` });
      if (!screened(r.error, c.db ?? undefined) || echoes(r.error, text) || r.stored > 0) failures.push(`${c.name}: ${why(r.error)}${r.stored ? " STORED" : ""}`);
    }
    check("G3", "every database-enforced format in the shared corpus is refused with 23514, names the pattern id, never echoes the text, and stores nothing", failures.length === 0 && (await countMine()) === before3, failures.join("; ") || `${corpus.filter((x) => x.db !== null).length} formats`);
    const gt = await secretAttempt(member, "member", "key in title", { title: `${marker} ${KEY}` });
    const gs = await secretAttempt(member, "member", "key in source note", { source_ref: `${marker} ${KEY}` });
    const zw = await secretAttempt(member, "member", "zero width key", { body: `Synthetic text. ${KEY.slice(0, 12)}${String.fromCharCode(0x200b)}${KEY.slice(12)} end.` });
    const ga = await secretAttempt(admin, "admin", "admin key", { body: `Synthetic text. ${KEY} end.` });
    check("G4", "a key in the title, in the source note, split by a zero-width character, or in an administrator's proposal is refused (23514), nothing stored", [gt, gs, zw, ga].every((r) => screened(r.error) && r.stored === 0 && !echoes(r.error, KEY)), [gt, gs, zw, ga].map((r) => why(r.error)).join("; "));
    const benign = await create(member, "member", "benign mention", { body: "Our password policy says passwords rotate every 90 days. The ticket is task-abcdefghijklmnop12345 and the key box is in room 4." });
    check("G5", "ordinary text that mentions passwords, keys and a ticket id is accepted", !!benign.item, why(benign.error));

    // G6: review notes (0012)
    const noteT = await mustCreate(admin, "admin", "note screening target", iso);
    const ev0 = (await events(noteT.id)).length;
    const n1 = await review(noteT.id, "approve", `use ${KEY} for billing`);
    const n2 = await review(noteT.id, "reject", `leaked ${KEY}`);
    const afterN = await asAdmin(noteT.id); const evN = await events(noteT.id);
    const unchanged = afterN?.status === "proposed" && !afterN.reviewed_by && !afterN.review_note && evN.length === ev0;
    const n3 = await review(noteT.id, "approve", "Checked with finance; an ordinary comment.");
    const n4 = await review(noteT.id, "expire", `old key ${KEY}`);
    const afterN4 = await asAdmin(noteT.id);
    check("G6", "a credential in an approve, reject or expire note is refused (23514, no echo) and changes nothing; a normal note still approves", screened(n1.error) && screened(n2.error) && screened(n4.error) && ![n1, n2, n4].some((r) => echoes(r.error, KEY)) && unchanged && !n3.error && afterN4?.status === "approved" && (await events(noteT.id)).length === ev0 + 1, `${why(n1.error)}; ${why(n2.error)}; approve ${why(n3.error)}; ${why(n4.error)}`);
    await retire(noteT.id);

    // G7 / G8 / G9: function surface and redaction authorization (0011, 0012)
    const hidden = ["knowledge_secret_signal", "knowledge_secret_guard", "knowledge_events_secret_guard"];
    const g7 = await Promise.all(hidden.flatMap((fn) => [member.db.rpc(fn, fn === "knowledge_secret_signal" ? { p_text: "x" } : {}), anon.rpc(fn, fn === "knowledge_secret_signal" ? { p_text: "x" } : {})]));
    check("G7", "the detector and both guard functions cannot be called by a member or by anon", g7.every((r) => !!r.error && r.data === null), g7.map((r) => r.error?.code ?? "ok").join(","));
    const redactT = await mustCreate(member, "member", "redaction authorization target", { topic: topicOf(runId, "gauth") });
    const g8m = await member.db.rpc("knowledge_redact", { p_id: redactT.id, p_reason: "other" });
    const g8a = await anon.rpc("knowledge_redact", { p_id: redactT.id, p_reason: "other" });
    const afterG8 = await asAdmin(redactT.id);
    check("G8", "a member and anon cannot call knowledge_redact; the item is unchanged", refusedWith(g8m.error, "42501") && !!g8a.error && afterG8?.status === "proposed" && afterG8.title === redactT.title, `${why(g8m.error)}; ${why(g8a.error)}`);
    const g9a = await admin.db.rpc("knowledge_redact", { p_id: redactT.id, p_reason: "because" });
    const g9b = await admin.db.rpc("knowledge_redact", { p_id: redactT.id, p_reason: null });
    const g9c = await admin.db.rpc("knowledge_redact", { p_id: ZERO, p_reason: "other" });
    check("G9", "knowledge_redact refuses an unknown or null reason (22023) and an unknown item (P0002)", refusedWith(g9a.error, "22023") && refusedWith(g9b.error, "22023") && refusedWith(g9c.error, "P0002") && (await asAdmin(redactT.id))?.title === redactT.title, `${why(g9a.error)}; ${why(g9b.error)}; ${why(g9c.error)}`);

    // G10: redact an approved item
    const bystander = await mustCreate(admin, "admin", "redaction bystander", iso);
    await review(bystander.id, "approve", "bystander note that must survive");
    const noteBefore = (await asAdmin(bystander.id))?.review_note;
    const evBystander = (await events(bystander.id)).map((e) => e.note).join("|");
    const rA = await mustCreate(member, "member", "redaction target approved", { topic: topicOf(runId, "gred"), source_ref: `${marker} source note` });
    await review(rA.id, "approve", "reviewer note that must be cleared");
    const visibleBeforeRedaction = await sees(rA.id);
    const red = await admin.db.rpc("knowledge_redact", { p_id: rA.id, p_reason: "other" });
    const full = (await admin.db.from("knowledge_items").select("title, body, topic, source_ref, review_note, status, redacted_at, reviewed_by").eq("id", rA.id).single()).data as { title: string; body: string; topic: string | null; source_ref: string | null; review_note: string | null; status: string; redacted_at: string | null; reviewed_by: string | null } | null;
    const evRA = await events(rA.id);
    const asMember = ((await member.db.from("knowledge_items").select("title, body").eq("id", rA.id)).data ?? []) as { title: string; body: string }[];
    const bystanderAfter = (await asAdmin(bystander.id))?.review_note === noteBefore && (await events(bystander.id)).map((e) => e.note).join("|") === evBystander && (await statusOf(bystander.id)) === "approved";
    check("G10", "redacting an approved item: content blanked, redacted_at set, expired, approver kept, history notes cleared with one fixed 'redacted' note, gone from retrieval; a bystander is untouched",
      visibleBeforeRedaction && !red.error && full?.title === "[Removed]" && full.body === "The content of this item was removed by an administrator." && full.topic === null && full.source_ref === null && full.review_note === null && full.status === "expired" && !!full.redacted_at && full.reviewed_by === A
      && evRA.map((e) => e.action).join(",") === "submitted,approved,redacted" && evRA[0].note === null && evRA[1].note === null && evRA[2].note === "Content removed (other)" && evRA[2].from_status === "approved" && evRA[2].to_status === "expired"
      && !(await sees(rA.id)) && asMember.length === 1 && asMember[0].title === "[Removed]" && bystanderAfter, `${why(red.error)}; ${full?.status}; ${evRA.map((e) => e.action).join(",")}`);
    await retire(bystander.id);

    // G11: redact a proposed item, then try to act on it again
    const red2 = await admin.db.rpc("knowledge_redact", { p_id: redactT.id, p_reason: "secret" });
    const full2 = await asAdmin(redactT.id); const ev2 = await events(redactT.id);
    const again = await admin.db.rpc("knowledge_redact", { p_id: redactT.id, p_reason: "secret" });
    const later = await Promise.all(["approve", "reject", "expire"].map((a) => review(redactT.id, a, "after removal")));
    check("G11", "redacting a proposed item rejects it and records the administrator; a second redaction and any later review are refused (55000)", !red2.error && full2?.status === "rejected" && full2.reviewed_by === A && full2.title === "[Removed]" && ev2.map((e) => e.action).join(",") === "submitted,redacted" && ev2[1].note === "Content removed (secret)" && refusedWith(again.error, "55000") && later.every((r) => refusedWith(r.error, "55000")), `${why(red2.error)}; ${why(again.error)}; ${later.map((r) => r.error?.code ?? "ok").join(",")}`);

    // G12: a redacted item cannot be named as the one to replace
    const g12 = await attempt(member, "names a redacted item", { supersedes_id: rA.id });
    check("G12", "a member cannot name a redacted item as the one to replace (42501)", refusedWith(g12, "42501"), why(g12));
  }

  // ------------------------------------------------------------------------------------------------ cleanup (always runs)
  async function cleanup() {
    console.log("\n--- cleanup (this run's rows only) ---");
    const notes: string[] = [];
    try {
      const swept = ((await admin.db.from("knowledge_items").select("id").like("title", `${markerOf(runId)}%`).limit(500)).data ?? []) as { id: string }[];
      let unexpected = 0;
      for (const r of swept) if (!manifest.items.some((m) => m.id === r.id)) { manifest.items.push({ id: r.id, label: "unexpected (found by marker sweep)", author: "member" }); unexpected++; }
      save();
      const ids = manifest.items.map((m) => m.id);
      let rejected = 0; let expired = 0;
      for (const id of ids) {
        const st = await statusOf(id);
        if (st === "proposed") { const r = await review(id, "reject", `live test cleanup ${runId}`); if (r.error) notes.push(`reject ${id}: ${why(r.error)}`); else rejected++; }
        else if (st === "approved") { const r = await review(id, "expire", `live test cleanup ${runId}`); if (r.error) notes.push(`expire ${id}: ${why(r.error)}`); else expired++; }
      }
      info(`cleanup: ${ids.length} items in the manifest (${unexpected} found only by the sweep); retired earlier ${retired.length}; rejected ${rejected}, expired ${expired}`);
      const states = await Promise.all(ids.map((id) => statusOf(id)));
      const open = states.filter((s) => s === "proposed" || s === "approved").length;
      const cur = new Set(await current()); const q = await admin.db.from("knowledge_items").select("id").eq("status", "proposed").like("title", `${markerOf(runId)}%`);
      check("F1", "cleanup moved every still-proposed item to rejected and every still-approved item to expired", notes.length === 0 && open === 0, notes.join("; "));
      check("F2", "no item of this run is proposed, approved or retrievable, and no unexpected row was stored", open === 0 && !ids.some((id) => cur.has(id)) && (q.data ?? []).length === 0 && unexpected === 0, unexpected ? `${unexpected} unexpected rows` : "");
    } catch (e) {
      check("F1", "cleanup completed", false, String((e as Error).message).slice(0, 100));
      console.error("CLEANUP FAILED. Items of this run may still be proposed/approved. Manifest:", manifestPath);
    }
    try {
      const now = { items: await count(admin.db, "knowledge_items"), events: await count(admin.db, "knowledge_events"), feedback: await count(admin.db, "answer_feedback"), audit: await count(admin.db, "chat_audit") };
      check("E6", "chat_audit row count equals the baseline (this script never inserts one)", now.audit === base.audit, `${base.audit} -> ${now.audit}`);
      check("F3", "residue is exactly what the manifest says", now.items === base.items + manifest.items.length && now.feedback === base.feedback + manifest.feedback.length, `items ${base.items}->${now.items}, events ${base.events}->${now.events}, feedback ${base.feedback}->${now.feedback}`);
      console.log(`\nRESIDUE (cannot be deleted through the API, by design): ${manifest.items.length} knowledge_items (all rejected/superseded/expired), ${now.events - base.events} knowledge_events, ${manifest.feedback.length} answer_feedback.`);
      console.log(`Identify them by title prefix "${markerOf(runId)}". Manifest: ${manifestPath}`);
      console.log(`To remove them, review then separately approve:  node --conditions=react-server --import tsx tests/live/knowledge-live-dev.script.ts --print-purge-sql "${manifestPath}"`);
      console.log(`Next run needs: KNOWLEDGE_LIVE_EXPECT_ROWS="${now.items},${now.events},${now.feedback}"`);
    } catch (e) { console.error("could not read final counts:", String((e as Error).message).slice(0, 100)); process.exitCode = 1; }
  }

  // Everything above is declared before this point runs (consts are not hoisted), and cleanup ALWAYS runs, also after a failure.
  try {
    await body();
  } catch (e) {
    rlog?.event("run_stopped_unexpected_error");
    console.error(`FAIL  run stopped by an unexpected error: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

function summary() {
  console.log("\n=== Summary ===");
  let pass = 0; let fail = 0; let blockedN = 0;
  for (const s of PLAN) {
    const r = reported.get(s.id);
    if (!r) { console.log(`NOT RUN ${s.id.padEnd(4)} ${s.text.slice(0, 90)}`); continue; }
    for (const x of r) { if (x.status === "PASS") pass++; else if (x.status === "FAIL") fail++; else blockedN++; }
  }
  const notRun = PLAN.filter((s) => !reported.has(s.id)).length;
  console.log(`${pass} passed, ${fail} failed, ${blockedN} blocked, ${notRun} not run`);
  if (fail > 0 || (notRun > 0 && (process.exitCode ?? 0) === 0)) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--dry-run") return dryRun();
  if (args[0] === "--print-purge-sql") {
    if (!args[1]) throw new Abort("Usage: --print-purge-sql <manifest.json>");
    const m = JSON.parse(readFileSync(args[1], "utf8")) as Manifest;
    if (m.target !== DEV_REF) throw new Abort("The manifest does not belong to the approved development project.");
    return void console.log(purgeSql(m));
  }
  if (args[0] === "--execute") {
    printPlan("LIVE EXECUTION");
    try { await live(); } catch (e) { rlog?.event(e instanceof Abort ? "run_refused_or_aborted" : "script_error"); throw e; } finally { rlog?.finish(PLAN, new Set(reported.keys())); }
    return summary();
  }
  throw new Abort("Choose a mode: --dry-run (no writes), --execute (live), or --print-purge-sql <manifest>.");
}

main().catch((e) => {
  console.error(e instanceof Abort ? `Stopped before any write: ${e.message}` : `Script error: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  process.exitCode = 2;
});
