// LOCAL ONLY. Never connects to any remote database. Proves that the security test script
// (0004_rls_and_jobs.proposed.sql) can FAIL: it applies 0001-0004 as the CLI's login role on PGlite, runs the script (it must pass),
// then deliberately removes ONE security control at a time in a scratch copy of the SQL and runs the script again (it must fail,
// and for the expected reason). A mutation that is NOT caught means the control has no regression test.
//
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/mutation_checks.pglite.mjs
//
// NOT covered here, and not claimed: FOR UPDATE SKIP LOCKED and the approval row lock need two overlapping transactions. PGlite is a
// single connection, so no result of this script says anything about them (see the BLIND list below, and the manual two-session
// procedure at the bottom of the 0004 script). Their text is pinned by tests/sql-security.test.ts instead.
// The files in supabase/ are only READ; mutations are written to a temporary folder that is removed at the end.
import { createEnv } from "./lib/pglite_env.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CR = String.fromCharCode(13);
const read = (f) => readFileSync(f, "utf8").split(CR).join("");   // normalise CRLF so the search texts match on any checkout
const root = fileURLToPath(new URL("../../", import.meta.url));
const FILES = ["migrations/0001_init.sql", "proposed/0002_hardening.proposed.sql", "proposed/0003_ai_brain.proposed.sql", "proposed/0004_ai_jobs.proposed.sql"];
const TEST = read(`${root}proposed/tests/0004_rls_and_jobs.proposed.sql`);

// [name, file index, text to remove/replace, replacement, regexp the failure message must match]
const MUTATIONS = [
  ["approval without the administrator check", 2,
    "if auth.uid() is null or not public.is_admin() then\n    raise exception 'only administrators can approve AI-proposed tasks' using errcode = '42501';\n  end if;", "",
    /expected 42501 but the statement succeeded[\s\S]*ai_approve_message/],
  ["task guard that trusts every writer", 2,
    "current_user not in ('authenticated', 'anon')", "true",
    /guard let a member keep source/],
  ["task guard without the reassignment rule", 2,
    "if not public.is_admin()\n     and new.assigned_to is not null", "if false\n     and new.assigned_to is not null",
    /expected 42501 but the statement succeeded[\s\S]*assigned_to/],
  ["task guard without the immutable-columns rule", 2,
    "elsif new.created_by is distinct from old.created_by\n     or new.source is distinct from old.source\n     or new.external_reference is distinct from old.external_reference\n     or new.created_at is distinct from old.created_at then",
    "elsif false then",
    /expected 42501 but the statement succeeded[\s\S]*(source|external_reference|created_by)/],
  ["integration guard missing", 1,
    "create trigger integrations_guard before update on public.integrations\n  for each row execute function public.integrations_guard();", "",
    /expected 42501 but the statement succeeded[\s\S]*integrations/],
  ["lease fence without the attempt counter (complete)", 3,
    "lease_owner = p_worker and attempts = p_attempt;\n  return found;\nend $$;\n\ncreate function public.ai_retry_job",
    "lease_owner = p_worker;\n  return found;\nend $$;\n\ncreate function public.ai_retry_job",
    /stale run \(attempt 1\) completed/],
  ["last-admin guard: delete trigger missing (also stops the auth-user cascade)", 0,
    "create trigger profiles_keep_an_admin_del before delete on public.profiles\n  for each row execute function public.profiles_keep_an_admin();", "",
    /expected 23514 but the statement succeeded[\s\S]*delete from/],
  ["last-admin guard: update trigger missing", 0,
    "create trigger profiles_keep_an_admin_upd before update of role on public.profiles\n  for each row execute function public.profiles_keep_an_admin();", "",
    /expected 23514 but the statement succeeded[\s\S]*update public\.profiles/],
  ["last-admin guard with a service-role bypass", 0,
    "if old.role = 'admin' and (tg_op = 'DELETE'", "if auth.uid() is null then return case when tg_op = 'DELETE' then old else new end; end if;\n  if old.role = 'admin' and (tg_op = 'DELETE'",
    /expected 23514 but the statement succeeded/],
  ["trigger functions still executable by service_role (0002 revoke without service_role)", 1,
    "  from public, anon, authenticated, service_role;\nrevoke execute on function public.is_admin() from public, anon, service_role;",
    "  from public, anon, authenticated;\nrevoke execute on function public.is_admin() from public, anon;",
    /can EXECUTE the trigger function/],

  // ---- least privilege on the AI tables and functions (0003/0004) ----
  ["service_role may UPDATE ai_jobs directly (over-grant)", 3,
    "grant select on public.ai_jobs to service_role;", "grant select, update on public.ai_jobs to service_role;",
    /expected 42501 but the statement succeeded[\s\S]*update public\.ai_jobs/],
  ["service_role may DELETE from ai_messages (over-grant)", 2,
    "grant select, insert, update on public.ai_messages to service_role;", "grant select, insert, update, delete on public.ai_messages to service_role;",
    /expected 42501 but the statement succeeded[\s\S]*delete from public\.ai_messages/],
  ["authenticated may TRUNCATE ai_jobs (over-grant)", 3,
    "grant select on public.ai_jobs to authenticated;", "grant select, truncate on public.ai_jobs to authenticated;",
    /expected 42501 but the statement succeeded[\s\S]*truncate public\.ai_jobs/],
  ["PUBLIC holds REFERENCES on ai_messages", 2,
    "grant select on public.ai_messages to authenticated;", "grant select on public.ai_messages to authenticated;\ngrant references on public.ai_messages to public;",
    /anon REFERENCES on public\.ai_messages/],
  ["ai_jobs left on the platform's default grants (revoke removed)", 3,
    "revoke all on public.ai_jobs from public, anon, authenticated, service_role;", "",
    /expected 42501 but the statement succeeded[\s\S]*ai_jobs/],
  ["ai_claim_job also executable by authenticated", 3,
    "grant execute on function public.ai_claim_job(text, integer) to service_role;", "grant execute on function public.ai_claim_job(text, integer) to service_role, authenticated;",
    /expected 42501 but the statement succeeded[\s\S]*ai_claim_job/],
  ["ai_claim_job still executable by PUBLIC (PUBLIC missing from the revoke)", 3,
    "revoke all on function public.ai_claim_job(text, integer) from public, anon, authenticated, service_role;", "revoke all on function public.ai_claim_job(text, integer) from anon, authenticated, service_role;",
    /expected 42501 but the statement succeeded[\s\S]*ai_claim_job/],

  // ---- fenced leases: each of complete / retry / fail must check the attempt counter ----
  ["lease fence without the attempt counter (retry)", 3,
    "lease_owner = p_worker and attempts = p_attempt and attempts < max_attempts;", "lease_owner = p_worker and attempts < max_attempts;",
    /stale run \(attempt 1\) rescheduled/],
  ["lease fence without the attempt counter (fail)", 3,
    "where correlation_id = p_job_id and status = 'processing' and lease_owner = p_worker and attempts = p_attempt;\n  return found;\nend $$;\n\n-- Administrator recovery",
    "where correlation_id = p_job_id and status = 'processing' and lease_owner = p_worker;\n  return found;\nend $$;\n\n-- Administrator recovery",
    /stale run \(attempt 1\) failed/],

  // ---- bounded leases and retry times ----
  ["lease length unbounded (no 10..3600 check)", 3,
    "if p_lease_seconds is null or p_lease_seconds not between 10 and 3600 then", "if p_lease_seconds is null then",
    /expected 22023 but the statement succeeded[\s\S]*ai_claim_job\('w', 9\)/],
  ["lease length without an upper bound", 3,
    "if p_lease_seconds is null or p_lease_seconds not between 10 and 3600 then", "if p_lease_seconds is null or p_lease_seconds < 10 then",
    /expected 22023 but the statement succeeded[\s\S]*ai_claim_job\('w', 3601\)/],
  ["worker name unvalidated", 3,
    "if p_worker is null or char_length(p_worker) not between 1 and 100 then", "if false then",
    /expected 22023 but the statement succeeded[\s\S]*ai_claim_job\(''/],
  ["retry time stored raw (no clamp)", 3,
    "v_run := least(greatest(p_run_at, now()), now() + interval '24 hours');", "v_run := p_run_at;",
    /not clamped to 24 hours/],
  ["retry time without the 24 h ceiling", 3,
    "v_run := least(greatest(p_run_at, now()), now() + interval '24 hours');", "v_run := greatest(p_run_at, now());",
    /not clamped to 24 hours/],
  ["retry time without the floor (a past time is stored)", 3,
    "v_run := least(greatest(p_run_at, now()), now() + interval '24 hours');", "v_run := least(p_run_at, now() + interval '24 hours');",
    /stored raw/],
  ["retry time may be null", 3,
    "if p_run_at is null then raise exception 'retry time required' using errcode = '22023'; end if;", "",
    /expected 22023 but the statement succeeded[\s\S]*retry-clamp/],

  // ---- job key and reference limits ----
  ["ambiguous job key (delimiter concatenation)", 3,
    "v_key text := array_to_json(array[p_provider, p_mailbox_ref, p_source_message_id])::text;", "v_key text := p_provider || '|' || p_mailbox_ref || '|' || p_source_message_id;",
    /ambiguous job key/],
  ["mailbox reference length not limited", 3,
    "char_length(mailbox_ref) <= 200", "true",
    /expected 23514 but the statement succeeded[\s\S]*repeat\('m', 201\)/],

  // ---- audit metadata values ----
  ["audit metadata values unchecked (free text accepted)", 2,
    "    if not coalesce(case e.key", "    if false and not coalesce(case e.key",
    /expected P0001 but the statement succeeded[\s\S]*Cannot read properties/],
  ["audit metadata: error_category accepts any text", 2,
    "      when 'error_category'  then jsonb_typeof(e.value) = 'null' or (e.value #>> '{}') in (", "      when 'error_category'  then true or (e.value #>> '{}') in (",
    /expected P0001 but the statement succeeded[\s\S]*Cannot read properties/],
  ["audit metadata: flags unbounded", 2,
    "jsonb_array_length(e.value) <= 12", "true",
    /expected P0001 but the statement succeeded[\s\S]*"v6"/],

  // ---- the public job id (12 hex characters) ----
  ["requeue accepts the internal row uuid as a job id", 3,
    "where correlation_id = p_job_id and status = 'failed';", "where (correlation_id = p_job_id or id::text = p_job_id) and status = 'failed';",
    /internal row uuid worked as a job id/],
  ["correlation id not constrained to 12 hex characters", 3,
    "check (correlation_id ~ '^[0-9a-f]{12}$'),", ",",
    /expected 23514 but the statement succeeded[\s\S]*NOTHEX123456/],
  ["correlation id not unique", 3,
    "correlation_id text not null unique check", "correlation_id text not null check",
    /expected 23505 but the statement succeeded/],

  // ---- the opaque review id ----
  ["approval ignores the id it was given (takes any waiting message)", 2,
    "select * into m from public.ai_messages where review_id = p_review_id for update;", "select * into m from public.ai_messages where status = 'REVIEW_REQUIRED' order by dedupe_key limit 1 for update;",
    /expected P0002 but the statement succeeded/],
  ["approval of an unknown id does not fail", 2,
    "if not found then raise exception 'message not found' using errcode = 'P0002'; end if;", "",
    /expected P0002/],
  ["review_id has no database default", 2,
    "review_id uuid not null unique default gen_random_uuid(),", "review_id uuid not null unique,",
    /review_id/],
];

// Mutations a SINGLE session cannot detect. They are listed so the limit is explicit, not hidden: the script is expected to still
// PASS with each of these, and the control is covered only by the static pin in tests/sql-security.test.ts and by the
// two-session procedure at the bottom of 0004_rls_and_jobs.proposed.sql on a real database.
const BLIND = [
  ["FOR UPDATE SKIP LOCKED removed from ai_claim_job (needs two sessions)", 3, "for update skip locked", "for update"],
  ["row lock removed from approval, FOR UPDATE (needs two sessions)", 2,
    "select * into m from public.ai_messages where review_id = p_review_id for update;", "select * into m from public.ai_messages where review_id = p_review_id;"],
];

/** Applies the (possibly mutated) migrations, then the test script. Returns { ok, message }. */
async function run(mutation) {
  const dir = mkdtempSync(join(tmpdir(), "broko-mut-"));
  try {
    const texts = FILES.map((f) => read(`${root}${f}`));
    if (mutation) {
      const [name, i, from, to] = mutation;
      if (texts[i].split(from).length !== 2) return { ok: false, message: `MUTATION TARGET NOT FOUND (exactly once) for: ${name}` };
      texts[i] = texts[i].replace(from, () => to);   // function form: "$$" in the text must stay literal
    }
    mkdirSync(dir, { recursive: true });
    const paths = texts.map((t, i) => { const p = join(dir, `${i}.sql`); writeFileSync(p, t); return p; });
    const env = await createEnv({ applyAs: "cli_login_postgres" });
    if (!(await env.apply(paths, { cliSetsRole: false }))) return { ok: false, message: "migrations did not apply: " + JSON.stringify(env.results.filter((r) => !r.ok)) };
    try { await env.db.exec(TEST); return { ok: true, message: "all checks passed" }; }
    catch (e) { return { ok: false, message: String(e.message).split("\n")[0] }; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

let bad = 0;
const base = await run(null);
console.log(`${base.ok ? "PASS" : "FAIL"}  baseline (real SQL): ${base.message}`);
if (!base.ok) bad++;
for (const m of MUTATIONS) {
  const r = await run(m);
  if (r.ok) { bad++; console.log(`FAIL  NOT CAUGHT: ${m[0]} (the test script still passed)`); continue; }
  const right = m[4].test(r.message);
  if (!right) bad++;
  console.log(`${right ? "PASS" : "FAIL"}  caught: ${m[0]}${right ? "" : `  [failed for another reason: ${r.message.slice(0, 160)}]`}`);
}
console.log("\nSingle-session blind spots (expected to PASS here; covered by the static pin and the two-session procedure, NOT by this run):");
for (const m of BLIND) {
  const r = await run(m);
  if (!r.ok && /TARGET NOT FOUND/.test(r.message)) { bad++; console.log(`FAIL  ${r.message}`); continue; }
  if (!r.ok) { bad++; console.log(`FAIL  ${m[0]}: the script failed for a reason that should not depend on concurrency: ${r.message.slice(0, 160)}`); continue; }
  console.log(`BLIND ${m[0]}: this run cannot see it (single session) - not claimed as tested`);
}
console.log(bad === 0 ? `\nALL OK: baseline passes and all ${MUTATIONS.length} mutations are caught; ${BLIND.length} concurrency-only controls are NOT covered by this script` : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
