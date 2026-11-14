/**
 * READ-ONLY smoke test of the Phase 2B relationship adapter against PostgREST on the DEVELOPMENT Supabase project (broko-dev). NOT part of `npm test`.
 * It performs SELECTs only (and, with --with-noop-rpc, three function calls whose inputs make them no-ops). It creates, changes and deletes nothing, never runs
 * ingestion or extraction, never reads BROKO_ORG_RELATIONSHIPS, and never uses a service-role key. Every call runs as the signed-in user (or anon).
 *
 *   node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-relationships-readonly.live-dev.script.ts --dry-run
 *   node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-relationships-readonly.live-dev.script.ts --execute [--with-noop-rpc]
 *
 * Environment (set in the window that runs it, never in a file): PRECON_LIVE_URL, PRECON_LIVE_CONFIRM=broko-dev, PRECON_LIVE_ANON_KEY,
 * PRECON_LIVE_ADMIN_EMAIL/_PASSWORD, PRECON_LIVE_MEMBER_EMAIL/_PASSWORD (same names as the other live scripts). Nothing here prints a secret or a row.
 *
 * WHY AN EMPTY TABLE STILL PROVES THE EMBEDS: PostgREST resolves embedded relationships from its schema cache when it PLANS the request, before it reads any
 * row. A wrong foreign-key hint fails (PGRST200/PGRST201) even when the table is empty, and a stale cache fails the same way. A 200 with [] therefore proves the
 * embeds resolve. What an empty table cannot show is row level security filtering: member vs admin reads look the same, so that is covered by privilege checks
 * (grants and function execution), and row filtering stays for the controlled write test.
 * Exit code: 0 = every check passed, 1 = a check failed, 2 = refused or aborted before any call.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../../src/lib/backend/supabase/profile";
import { createSupabaseOrgMemory, REL_SELECT } from "../../src/lib/backend/supabase/org-memory";
import type { Profile } from "../../src/lib/types";
import { DEV_REF, targetProblems } from "./lib/knowledge-live-plan";
import { signInFailureMessage } from "./lib/org-memory-live-plan";
import { describeErr, expectEmpty, expectNoAccess, schemaHint, type PgErr, type Probe } from "./lib/org-relationships-smoke-plan";

class Abort extends Error {}
const ZERO = "00000000-0000-4000-8000-000000000000";
const ZERO2 = "00000000-0000-4000-8000-000000000001";
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Abort(`Missing ${k}`); return v; };
const mode = process.argv.includes("--execute") ? "exec" : process.argv.includes("--dry-run") ? "dry" : null;
const noopRpc = process.argv.includes("--with-noop-rpc");
const NAMES = ["PRECON_LIVE_URL", "PRECON_LIVE_CONFIRM", "PRECON_LIVE_ANON_KEY", "PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD", "PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD"];

const END = "id, entity_type, name, review_status, stale, pending_revision, source_doc_id";
/** Every select this script sends, by name. The first is the adapter's own string; the rest isolate each embed and add negative controls. */
export const QUERIES: readonly { id: string; table: string; select: string; note: string }[] = [
  { id: "Q1", table: "org_relationships", select: REL_SELECT, note: "the adapter's full embedded select (doc, from, to)" },
  { id: "Q2", table: "org_relationships", select: `id, from:org_entities!org_relationships_from_entity_id_fkey(${END})`, note: "from-endpoint embed alone" },
  { id: "Q3", table: "org_relationships", select: `id, to:org_entities!org_relationships_to_entity_id_fkey(${END})`, note: "to-endpoint embed alone" },
  { id: "Q4", table: "org_relationships", select: "id, doc:org_source_docs!inner(archived)", note: "document embed alone (single foreign key path)" },
  { id: "Q5", table: "org_relationship_events", select: "relationship_id, created_at, actor_id, action, note", note: "history table" },
];

const probes: Probe[] = [];
const record = (id: string, title: string, ok: boolean, detail: string) => { probes.push({ id, title, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(5)} ${title}${detail ? `  [${detail}]` : ""}`); };
const info = (s: string) => console.log(`INFO        ${s}`);

function dry() {
  console.log("\n=== Read-only relationship smoke test (DRY RUN: nothing is contacted) ===");
  for (const q of QUERIES) console.log(`  ${q.id}  GET /rest/v1/${q.table}?select=${q.select.slice(0, 110)}${q.select.length > 110 ? "..." : ""}\n        ${q.note}`);
  console.log("  Negative controls (must FAIL with the codes shown):  N1 embed without a hint -> PGRST201 or PGRST200;  N2 embed with a wrong hint -> PGRST200");
  console.log("  Adapter calls (admin): findRelationships, listRelationshipQueue, getRelationship(zero id); (member): the same, refused before any call");
  console.log("  Direct reads: anon denied; member empty or denied");
  console.log(`  --with-noop-rpc (${noopRpc ? "ON" : "off"}): org_relationship_review/upsert/stale_missing with all-zero or empty inputs: reachability and signature only, no data can change`);
  for (const k of NAMES) console.log(`  ${k.padEnd(28)}: ${process.env[k] ? "set" : "NOT SET"}`);
  const p = targetProblems({ url: process.env.PRECON_LIVE_URL, confirm: process.env.PRECON_LIVE_CONFIRM, key: process.env.PRECON_LIVE_ANON_KEY, linkedRef: DEV_REF });
  console.log(p.length ? `  a run would be REFUSED now:\n${p.map((x) => `    - ${x}`).join("\n")}` : "  target guard: passes");
}

async function signIn(url: string, key: string, emailKey: string, passKey: string): Promise<{ db: SupabaseClient; profile: Profile }> {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.auth.signInWithPassword({ email: need(emailKey), password: need(passKey) });
  if (error) throw new Abort(signInFailureMessage(emailKey, error));
  const { data: u } = await db.auth.getUser();
  if (!u.user) throw new Abort(`No user after sign-in for ${emailKey}.`);
  const { data: row } = await db.from("profiles").select(PROFILE_COLUMNS).eq("id", u.user.id).maybeSingle();
  if (!row) throw new Abort("No profile row for the signed-in user.");
  return { db, profile: toProfile(row as ProfileRow, u.user.email) };
}

async function run() {
  const problems = targetProblems({ url: process.env.PRECON_LIVE_URL, confirm: process.env.PRECON_LIVE_CONFIRM, key: process.env.PRECON_LIVE_ANON_KEY, linkedRef: DEV_REF });
  if (problems.length) throw new Abort(`Refusing to run: ${problems.join("; ")}`);
  const url = need("PRECON_LIVE_URL"); const key = need("PRECON_LIVE_ANON_KEY");
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const admin = await signIn(url, key, "PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  const member = await signIn(url, key, "PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD");
  record("A1", "admin and member sign in with roles admin and member", admin.profile.role === "admin" && member.profile.role === "member" && admin.profile.id !== member.profile.id, "");
  if (admin.profile.role !== "admin" || member.profile.role !== "member") throw new Abort("Session roles are not as required.");

  // --- the exact embedded selects, as admin (PostgREST plans them against the schema cache) ---
  for (const q of QUERIES) {
    const res = await admin.db.from(q.table).select(q.select).limit(5);
    const r = expectEmpty({ data: res.data, error: res.error as PgErr | null });
    record(q.id, `admin  ${q.note}`, r.ok, r.detail);
    const hint = schemaHint(res.error as PgErr | null); if (hint) info(`${q.id}: ${hint}`);
  }
  // --- negative controls: prove the hints matter (a check that cannot fail proves nothing) ---
  const n1 = await admin.db.from("org_relationships").select("id, e:org_entities(id)").limit(1);
  record("N1", "embed WITHOUT a hint is refused (two foreign keys: ambiguous)", Boolean(n1.error) && ["PGRST201", "PGRST200"].includes(String((n1.error as PgErr).code)), describeErr(n1.error as PgErr | null));
  const n2 = await admin.db.from("org_relationships").select("id, e:org_entities!org_relationships_no_such_fkey(id)").limit(1);
  record("N2", "embed with a WRONG hint is refused", Boolean(n2.error) && String((n2.error as PgErr).code) === "PGRST200", describeErr(n2.error as PgErr | null));

  // --- the adapter itself, as admin ---
  const A = createSupabaseOrgMemory(admin.db, admin.profile).reader;
  const thrown = async <T>(f: () => Promise<T>): Promise<{ v?: T; err?: string }> => { try { return { v: await f() }; } catch (e) { return { err: e instanceof Error ? e.constructor.name + (e.message ? `: ${e.message.slice(0, 80)}` : "") : "error" }; } };
  const f = await thrown(() => A.findRelationships({ limit: 25 }));
  record("D1", "adapter findRelationships returns an empty list without error", Array.isArray(f.v) && f.v.length === 0, f.err ?? `${f.v?.length ?? "?"} rows`);
  const fq = await thrown(() => A.findRelationships({ limit: 25, relation_type: "ASSIGNED_TO", include_rejected: true }));
  record("D2", "adapter findRelationships with a type filter and include_rejected: empty, no error", Array.isArray(fq.v) && fq.v.length === 0, fq.err ?? `${fq.v?.length ?? "?"} rows`);
  const fn = await thrown(() => A.findRelationships({ limit: 25, query: "smoke" }));
  record("D3", "adapter findRelationships by name (searches entities first): empty, no error", Array.isArray(fn.v) && fn.v.length === 0, fn.err ?? `${fn.v?.length ?? "?"} rows`);
  const lq = await thrown(() => A.listRelationshipQueue(25));
  record("D4", "adapter listRelationshipQueue returns an empty list without error", Array.isArray(lq.v) && lq.v.length === 0, lq.err ?? `${lq.v?.length ?? "?"} rows`);
  const g = await thrown(() => A.getRelationship(ZERO));
  record("D5", "adapter getRelationship(unknown id) returns null without error", g.v === null && !g.err, g.err ?? "null");

  // --- authorization: no data to change, so these are privilege checks ---
  const M = createSupabaseOrgMemory(member.db, member.profile).reader;
  const mf = await thrown(() => M.findRelationships({ limit: 25 }));
  record("Z1", "member adapter refuses (empty) before any call", Array.isArray(mf.v) && mf.v.length === 0, mf.err ?? "empty");
  const mg = await thrown(() => M.getRelationship(ZERO));
  record("Z2", "member adapter getRelationship returns null", mg.v === null && !mg.err, mg.err ?? "null");
  for (const [who, db] of [["member", member.db], ["anon", anon]] as const) {
    const rel = await db.from("org_relationships").select(REL_SELECT).limit(5);
    const r = expectNoAccess({ data: rel.data, error: rel.error as PgErr | null, status: rel.status });
    record(`Z3${who === "member" ? "m" : "a"}`, `${who} direct read of org_relationships: refused or empty`, r.ok, r.detail);
    const ev = await db.from("org_relationship_events").select("relationship_id").limit(5);
    const e = expectNoAccess({ data: ev.data, error: ev.error as PgErr | null, status: ev.status });
    record(`Z4${who === "member" ? "m" : "a"}`, `${who} direct read of org_relationship_events: refused or empty`, e.ok, e.detail);
  }
  info("Row level security FILTERING cannot be observed while the tables are empty: member and admin reads look alike. Privileges are checked above; filtering is left to the controlled write test.");

  if (noopRpc) {
    // All-zero or empty inputs: the database function checks the caller first, then finds nothing to do. Nothing can be created or changed.
    const rev = await admin.db.rpc("org_relationship_review", { p_id: ZERO, p_action: "approve", p_note: null });
    record("R1", "admin org_relationship_review(unknown id) reaches the function: 'record not found' (P0002)", String((rev.error as PgErr | null)?.code) === "P0002", describeErr(rev.error as PgErr | null));
    const stale = await admin.db.rpc("org_relationship_stale_missing", { p_doc: ZERO, p_keep: [] });
    record("R2", "admin org_relationship_stale_missing(empty keep) returns 0", !stale.error && stale.data === 0, stale.error ? describeErr(stale.error as PgErr) : `data=${String(stale.data)}`);
    const up = await admin.db.rpc("org_relationship_upsert", { p_doc: ZERO, p_stable: "smoke-noop-id", p_from: ZERO, p_to: ZERO2, p_type: "RELATES_TO", p_evidence: ["S1"], p_basis: "inferred", p_confidence: "low" });
    record("R3", "admin org_relationship_upsert(unknown endpoints) returns 'skipped'", !up.error && up.data === "skipped", up.error ? describeErr(up.error as PgErr) : `data=${String(up.data)}`);
    const mrev = await member.db.rpc("org_relationship_review", { p_id: ZERO, p_action: "approve", p_note: null });
    record("R4", "member org_relationship_review is refused by the guard (42501)", String((mrev.error as PgErr | null)?.code) === "42501", describeErr(mrev.error as PgErr | null));
    const arev = await anon.rpc("org_relationship_review", { p_id: ZERO, p_action: "approve", p_note: null });
    record("R5", "anon org_relationship_review is denied (42501 / 401)", String((arev.error as PgErr | null)?.code) === "42501" || arev.status === 401, describeErr({ status: arev.status, ...(arev.error as PgErr | null) }));
  } else info("Function reachability (R1-R5) was not run: pass --with-noop-rpc to include it.");

  const failed = probes.filter((p) => !p.ok).length;
  console.log(`\nSUMMARY  ${probes.length - failed} passed, ${failed} failed (read-only; nothing was created, changed or deleted)`);
  process.exitCode = failed ? 1 : 0;
}

(async () => {
  try {
    if (mode === "dry") dry();
    else if (mode === "exec") await run();
    else { console.error("Pass exactly one of --dry-run or --execute [--with-noop-rpc]."); process.exitCode = 2; }
  } catch (e) {
    if (e instanceof Abort) { console.error(`ABORTED: ${e.message}`); process.exitCode = 2; }
    else { console.error("The smoke test stopped on an unexpected error (details withheld)."); process.exitCode = 1; }
  }
})();
