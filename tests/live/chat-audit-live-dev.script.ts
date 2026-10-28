/**
 * LIVE verification of the chat audit trail (migration 0008) against the DEVELOPMENT Supabase project. NOT part of `npm test`
 * (it is not named *.test.ts and it needs a real project). Every call goes through the real HTTP API as a signed-in user, so it
 * proves what the database enforces, not what the app intends.
 *
 * Preconditions (the owner does these): 0001, 0002, 0006, 0007 and 0008 applied to broko-dev; the two SYNTHETIC users used by the
 * Pre-Construction live script exist (one admin, one member).
 *
 * Run in Windows PowerShell (credentials in the environment of that window, never in a file, never in chat; Read-Host -AsSecureString
 * keeps typed secrets off the screen). Use the publishable (anon) key only, never the secret key:
 *   $env:PRECON_LIVE_URL = "https://olngcbgkxbceqpikcyxk.supabase.co"
 *   $env:PRECON_LIVE_CONFIRM = "broko-dev"
 *   $env:PRECON_LIVE_ANON_KEY = "<publishable key of broko-dev>"
 *   $env:PRECON_LIVE_ADMIN_EMAIL / PRECON_LIVE_ADMIN_PASSWORD / PRECON_LIVE_MEMBER_EMAIL / PRECON_LIVE_MEMBER_PASSWORD = <test accounts>
 *   node --conditions=react-server --import tsx tests/live/chat-audit-live-dev.script.ts
 * (On a POSIX shell, set the same variables inline before `node`.) Exit code 0 = every check passed, 1 = a check failed,
 * 2 = a precondition failed (missing variable, wrong project, sign-in failure) before any test ran.
 *
 * It uses only the public anon key and user sessions (never a service-role key). It WRITES metadata-only audit rows that this API
 * cannot delete by design: 3 from the functional checks (two as the member, one as the admin; every other insert is refused) plus
 * the burst, which stores 120 minus the member's rows from the last minute (118 in the 2026-10-28 run), so about 121 per run.
 * They hold no text. The concurrency burst runs LAST because it deliberately puts the member
 * at the per-minute cap. Prints PASS/FAIL per check with no secrets.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseChatAudit } from "../../src/lib/backend/supabase/chat-audit";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../../src/lib/backend/supabase/profile";
import { createSupabasePreconRepo, createSupabaseFileStore } from "../../src/lib/backend/supabase/precon";
import { createSupabaseRepo } from "../../src/lib/backend/supabase/repo";
import type { Repo } from "../../src/lib/backend/types";
import { handleChat } from "../../src/lib/chat-service";
import type { Profile } from "../../src/lib/types";

const DEV_REF = "olngcbgkxbceqpikcyxk";
const BURST = 150;
const CAP = 120;
const BURST_TAG = 99; // record_count value that marks this run's burst rows (valid for the column, never produced by the app's own functional checks)
/** A precondition failed. Reported and turned into exit code 2 by main(); never process.exit(), which crashes Node on Windows
 *  (libuv "UV_HANDLE_CLOSING" assertion) while HTTP handles are still closing. The message never contains a secret. */
class Abort extends Error {}
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Abort(`Missing ${k}`);
  return v;
};

let url = "";
let anon = "";
/** Reads and checks the target before anything touches the network. */
function configure() {
  url = need("PRECON_LIVE_URL");
  anon = need("PRECON_LIVE_ANON_KEY");
  let host = "";
  try { host = new URL(url).hostname.split(".")[0]; } catch { /* reported below */ }
  if (host !== DEV_REF || process.env.PRECON_LIVE_CONFIRM !== "broko-dev") {
    throw new Abort("Refusing to run: the URL is not the approved development project, or PRECON_LIVE_CONFIRM=broko-dev is missing.");
  }
}

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const info = (s: string) => console.log(`INFO  ${s}`);
type Err = { code?: string; message?: string } | null;
const why = (e: Err) => (e ? `${e.code ?? "?"}: ${String(e.message ?? "").slice(0, 90)}` : "no error");

interface Session { db: SupabaseClient; profile: Profile; peak: () => number; resetPeak: () => void }

async function signIn(emailKey: string, passKey: string): Promise<Session> {
  let inFlight = 0;
  let peak = 0;
  const tracked: typeof fetch = async (input, init) => {
    inFlight++; peak = Math.max(peak, inFlight);
    try { return await fetch(input, init); } finally { inFlight--; }
  };
  const db = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: tracked } });
  const { error } = await db.auth.signInWithPassword({ email: need(emailKey), password: need(passKey) });
  if (error) throw new Abort(`Sign-in failed for ${emailKey}: ${error.message}`);
  const { data: u } = await db.auth.getUser();
  if (!u.user) throw new Abort(`No user returned after sign-in for ${emailKey}.`);
  const { data: row } = await db.from("profiles").select(PROFILE_COLUMNS).eq("id", u.user.id).maybeSingle();
  if (!row) throw new Abort("No profile row for the signed-in user.");
  return { db, profile: toProfile(row as ProfileRow, u.user!.email), peak: () => peak, resetPeak: () => { peak = inFlight; } };
}

const baseRow = (actor: string, over: Record<string, unknown> = {}) => ({
  actor_id: actor, intent: "summary", outcome: "answered", project_id: null, source_ids: ["tasks"], record_count: 1, has_evidence: true, used_model: false, latency_ms: 7, ...over,
});

/** Rows by one actor, read as the admin (the only role that can read this table). */
async function rowsOf(admin: Session, actor: string, sinceIso?: string) {
  let q = admin.db.from("chat_audit").select("id, actor_id, created_at, intent, outcome, source_ids, record_count, has_evidence, used_model, latency_ms").eq("actor_id", actor).order("created_at", { ascending: true }).limit(1000);
  if (sinceIso) q = q.gte("created_at", sinceIso);
  const { data, error } = await q;
  if (error) throw new Error(`admin read failed: ${why(error)}`);
  return data ?? [];
}

/** The most rows any 60-second window contains (by the database's own created_at): the cap's real invariant. */
function maxInAnyMinute(stamps: string[]): number {
  const t = stamps.map((s) => Date.parse(s)).sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i] - t[j] >= 60_000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

async function main() {
  configure();
  const admin = await signIn("PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  const member = await signIn("PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD");
  const M = member.profile.id;
  const A = admin.profile.id;
  const started = new Date(Date.now() - 2000).toISOString();
  check("setup: admin profile has role admin", admin.profile.role === "admin");
  check("setup: member profile has role member", member.profile.role === "member");

  // ---------------------------------------------------------------- inserts through the real adapter and the real API
  const writer = createSupabaseChatAudit(member.db, M);
  let adapterErr = "";
  try { await writer.record({ intent: "summary", outcome: "answered", project_id: null, source_ids: ["tasks"], record_count: 2, has_evidence: true, used_model: false, latency_ms: 11 }); } catch (e) { adapterErr = String((e as Error).message); }
  check("a member records a row through the app's own writer", adapterErr === "", adapterErr);

  const ret = await member.db.from("chat_audit").insert(baseRow(M)).select("id");
  check("a member cannot read a row back with RETURNING (so the app must not ask for it)", !!ret.error, why(ret.error));
  const forged = await member.db.from("chat_audit").insert(baseRow(A));
  check("a member cannot record a row as someone else", forged.error?.code === "42501", why(forged.error));
  for (const [col, val] of [["created_at", "2020-01-01T00:00:00Z"], ["organization_id", "11111111-2222-4333-8444-555555555555"], ["id", "11111111-2222-4333-8444-555555555555"]] as const) {
    const r = await member.db.from("chat_audit").insert(baseRow(M, { [col]: val }));
    check(`a client cannot set ${col} (column privilege)`, r.error?.code === "42501", why(r.error));
  }
  const badIntent = await member.db.from("chat_audit").insert(baseRow(M, { intent: "what is Dana's salary?" }));
  check("free text in intent is refused by the database", badIntent.error?.code === "23514", why(badIntent.error));
  const badSrc = await member.db.from("chat_audit").insert(baseRow(M, { source_ids: ["tasks", "my private note"] }));
  check("free text in source_ids is refused by the database", badSrc.error?.code === "23514", why(badSrc.error));
  const extra = await member.db.from("chat_audit").insert({ ...baseRow(M), message: "the question text" } as never);
  check("an extra 'message' column cannot be written (no such column)", !!extra.error, why(extra.error));
  check("an administrator records a row as themself", !(await admin.db.from("chat_audit").insert(baseRow(A))).error);

  // ---------------------------------------------------------------- the app end to end
  const repoFor = async (p: Profile, db: SupabaseClient): Promise<Repo> => ({
    ...createSupabaseRepo(db, p.id), precon: createSupabasePreconRepo(db, p), preconFiles: createSupabaseFileStore(db), chatAudit: createSupabaseChatAudit(db, p.id),
  });
  const before = (await rowsOf(admin, M, started)).length;
  const QUESTION = "ZEBRA-QUOKKA-9317 Summarize my pending tasks.";
  const logs: string[] = [];
  const res = await handleChat({ user: member.profile, backendKind: "supabase", repoFor: (p) => repoFor(p, member.db), log: (e) => logs.push(String((e as Error)?.message ?? e).slice(0, 80)) }, QUESTION);
  check("the app answers a real question as the member", res.ok === true, res.ok ? "" : res.error);
  const after = await rowsOf(admin, M, started);
  check("that question produced exactly one audit row", after.length === before + 1, `${before} -> ${after.length}`);
  const last = after[after.length - 1];
  check("the row is metadata only (no text-valued field beyond intent/outcome/source ids)", Object.keys(last).sort().join(",") === "actor_id,created_at,has_evidence,id,intent,latency_ms,outcome,record_count,source_ids,used_model");
  check("the question's words appear nowhere in the stored row", !JSON.stringify(last).includes("ZEBRA") && !JSON.stringify(last).includes("QUOKKA"));
  check("the app logged no audit failure", !logs.some((l) => /audit/i.test(l)), logs.join(" | "));

  // ---------------------------------------------------------------- reads
  const adminRows = await rowsOf(admin, M, started);
  check("an administrator reads the member's rows", adminRows.length >= 2, `${adminRows.length} rows`);
  const mAll = await member.db.from("chat_audit").select("*");
  check("a member's SELECT returns no rows at all (not even their own), with no error", !mAll.error && (mAll.data ?? []).length === 0, `${(mAll.data ?? []).length} rows, ${why(mAll.error)}`);
  const mOwn = await member.db.from("chat_audit").select("id", { count: "exact", head: true }).eq("actor_id", M);
  check("a member cannot count or filter their own rows either", !mOwn.error && mOwn.count === 0, `count=${mOwn.count}`);
  const mAdminRows = await member.db.from("chat_audit").select("id").eq("actor_id", A);
  check("a member cannot read the administrator's rows", !mAdminRows.error && (mAdminRows.data ?? []).length === 0);
  const aOwn = await admin.db.from("chat_audit").select("id", { count: "exact", head: true });
  check("an administrator can count every row", !aOwn.error && (aOwn.count ?? 0) >= adminRows.length, `count=${aOwn.count}`);

  // ---------------------------------------------------------------- immutability
  for (const [who, s] of [["a member", member], ["an administrator", admin]] as const) {
    const up = await s.db.from("chat_audit").update({ outcome: "error" }).eq("id", last.id);
    check(`${who} cannot update an audit row`, up.error?.code === "42501", why(up.error));
    const del = await s.db.from("chat_audit").delete().eq("id", last.id);
    check(`${who} cannot delete an audit row`, del.error?.code === "42501", why(del.error));
  }
  const stillThere = await rowsOf(admin, M, started);
  check("the row is unchanged after those attempts", stillThere.some((r) => r.id === last.id && r.outcome === last.outcome));
  const anonDb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonRead = await anonDb.from("chat_audit").select("id");
  check("anon cannot read the table", !!anonRead.error || (anonRead.data ?? []).length === 0, why(anonRead.error));
  const anonIns = await anonDb.from("chat_audit").insert(baseRow(M));
  check("anon cannot insert", !!anonIns.error, why(anonIns.error));

  // ---------------------------------------------------------------- concurrency: LAST, it puts the member at the cap
  const recentBefore = (await rowsOf(admin, M, new Date(Date.now() - 60_000).toISOString())).length;
  info(`burst: ${BURST} simultaneous inserts as ONE member; rows already in the last minute: ${recentBefore}; cap: ${CAP}`);
  member.resetPeak();
  const t0 = Date.now();
  const timings: number[] = [];
  const outcomes = await Promise.all(Array.from({ length: BURST }, async (_, i) => {
    const s = Date.now();
    const r = await member.db.from("chat_audit").insert(baseRow(M, { latency_ms: i, record_count: BURST_TAG }));
    timings.push(Date.now() - s);
    return r.error ? { ok: false as const, code: r.error.code ?? "?", status: r.status } : { ok: true as const };
  }));
  const wall = Date.now() - t0;
  const accepted = outcomes.filter((o) => o.ok).length;
  const refused = outcomes.filter((o): o is { ok: false; code: string; status: number } => !o.ok);
  const byCode: Record<string, number> = {};
  for (const r of refused) byCode[r.code] = (byCode[r.code] ?? 0) + 1;
  const sum = timings.reduce((a, b) => a + b, 0);
  timings.sort((a, b) => a - b);
  info(`burst result: accepted=${accepted} refused=${refused.length} refusal codes=${JSON.stringify(byCode)}`);
  info(`burst timing: wall=${wall} ms, peak in-flight HTTP requests (client side)=${member.peak()}, request time min/median/max=${timings[0]}/${timings[timings.length >> 1]}/${timings[timings.length - 1]} ms, sum/wall=${(sum / wall).toFixed(1)}`);

  const stored = await rowsOf(admin, M, started);
  const burstRows = stored.filter((r) => r.record_count === BURST_TAG);
  const staleBurst = (await rowsOf(admin, M)).filter((r) => r.record_count === BURST_TAG && Date.parse(r.created_at) < t0 - 120_000).length;
  if (staleBurst > 0) info(`note: ${staleBurst} burst-tagged rows from an earlier run exist; they are older than 2 minutes and do not affect this run's window`);
  const worst = maxInAnyMinute(stored.map((r) => r.created_at));
  check("every one of the 150 requests got a definite answer (accepted or refused)", accepted + refused.length === BURST);
  check(`the number of rows STORED by the burst equals the number accepted (${accepted})`, burstRows.length === accepted, `stored=${burstRows.length}`);
  check(`the cap held: no 60-second window contains more than ${CAP} of this member's rows`, worst <= CAP, `worst window=${worst}`);
  check(`the cap fired: some requests were refused with the cap's error (54000)`, (byCode["54000"] ?? 0) > 0, JSON.stringify(byCode));
  check(`nothing was refused for any other reason`, refused.length === (byCode["54000"] ?? 0), JSON.stringify(byCode));
  check(`the burst filled the cap exactly (accepted = ${CAP} - rows already in the window = ${CAP - recentBefore})`, accepted === CAP - recentBefore, `accepted=${accepted}`);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== chat audit LIVE on broko-dev: ${results.length - bad.length}/${results.length} checks passed ===`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

// Never process.exit(): set the exit code and let Node close its handles itself. No client here keeps a timer or session alive
// (persistSession and autoRefreshToken are off), so the process ends on its own after a failed sign-in.
main().catch((e) => {
  console.error(e instanceof Abort ? `Stopped before any test ran: ${e.message}` : `Script error: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  process.exitCode = 2;
});
