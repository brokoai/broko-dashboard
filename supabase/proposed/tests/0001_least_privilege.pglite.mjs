// LOCAL ONLY. Never connects to any remote database. Runs supabase/migrations/0001_init.sql in an in-process PostgreSQL
// (PGlite, real PostgreSQL semantics) that imitates the parts of Supabase that matter for privileges: roles, an auth
// schema stub, the dev project's default privileges (copied from its pg_default_acl) and the platform's rls_auto_enable
// event trigger (copied verbatim). It then checks the privilege matrix, ownership, and real behaviour under each role.
//
// Not a repo dependency: install it temporarily without touching package.json, then run from the repo root:
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/0001_least_privilege.pglite.mjs
// Scenarios (environment variables):
//   APPLY_AS=cli_login_postgres   apply as the CLI's login role: member of postgres with SET but NOT INHERIT, no CREATE on public
//   CLI_SETS_ROLE=1               ...and assume the CLI already issued SET SESSION ROLE postgres itself (unconfirmed; test both)
//   NO_EVENT_TRIGGER=1            omit the platform event trigger (it swallows its own failures)
//   ASSERT_SQL=<file>             also run a read-only assertion script after applying (default: 0001_privileges.proposed.sql)
//   VERBOSE=1 / MATRIX=1          print every check / the privilege matrix
// Exit code 0 = every check passed. Pass another migration path as argv[2] to compare (e.g. the pre-hardening file from git).
import { createEnv } from "./lib/pglite_env.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const file = process.argv[2] ?? `${here}../../migrations/0001_init.sql`;
const label = process.argv[3] ?? "supabase/migrations/0001_init.sql";
process.env.ASSERT_SQL ??= `${here}0001_privileges.proposed.sql`;

const env = await createEnv();
const { db, results, check, attempt, applyAs } = env;
const applied = await env.apply([file]);
if (applied && process.env.ASSERT_SQL) {
  // The read-only assertion script exactly as it would run on the remote: it must pass on a correct migration.
  try { await db.exec(readFileSync(process.env.ASSERT_SQL, "utf8")); check("read-only SQL assertion script passes", true); }
  catch (e) { check("read-only SQL assertion script passes", false, String(e.message).slice(0, 160)); }
}
if (!applied) { print(); process.exit(1); }

// ---------------------------------------------------------------- helpers
const priv = async (role, obj, p) => (await db.query(`select has_table_privilege($1, $2, $3) v`, [role, obj, p])).rows[0].v;

const TABLES = ["profiles", "tasks", "activity_events", "notifications", "integrations"];
const roles = ["anon", "authenticated", "service_role"];

// ---------------------------------------------------------------- structure facts
for (const t of TABLES) {
  const r = (await db.query(`select relrowsecurity rls, relforcerowsecurity f, relowner::regrole::text o from pg_class where oid = 'public.${t}'::regclass`)).rows[0];
  check(`RLS enabled on ${t}`, r.rls);
  check(`${t} is not FORCE RLS (definer triggers must still work)`, !r.f);
}
const fnConf = (await db.query(`select p.proname, p.prosecdef, p.proconfig::text cfg, p.proowner::regrole::text o from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname <> 'rls_auto_enable' order by 1`)).rows;
for (const f of fnConf.filter((x) => x.prosecdef)) check(`security definer ${f.proname} pins search_path`, /search_path=("")?(public|pg_temp|, *)*/.test(f.cfg ?? "") && (f.cfg ?? "").includes("search_path"), f.cfg);

const owners = (await db.query(`select c.relname n, c.relowner::regrole::text o from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','S','v')`)).rows;
for (const r of owners) check(`table ${r.n} is owned by postgres`, r.o === "postgres", r.o);
for (const f of fnConf) check(`function ${f.proname} is owned by postgres`, f.o === "postgres", f.o);
for (const f of fnConf.filter((x) => x.prosecdef)) check(`definer ${f.proname} search_path is exactly ''`, (f.cfg ?? '').split(String.fromCharCode(92)).join('') === '{"search_path="""}', f.cfg);
// ---------------------------------------------------------------- privilege matrix
const matrix = {};
for (const role of roles) for (const t of TABLES) {
  const have = [];
  for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) if (await priv(role, `public.${t}`, p)) have.push(p);
  matrix[`${role}.${t}`] = have.join(",") || "-";
}
// Intended least-privilege matrix (table-level privileges only; column grants checked separately).
const intended = {
  anon: { profiles: "-", tasks: "-", activity_events: "-", notifications: "-", integrations: "-" },
  authenticated: { profiles: "SELECT", tasks: "SELECT", activity_events: "SELECT", notifications: "SELECT", integrations: "SELECT" },
  service_role: { profiles: "SELECT,UPDATE", tasks: "SELECT,INSERT,UPDATE", activity_events: "SELECT,INSERT", notifications: "SELECT,INSERT,UPDATE", integrations: "SELECT,UPDATE" },
};
for (const role of roles) for (const t of TABLES) {
  // authenticated also gets column-level INSERT/UPDATE (counted separately), so compare only the table-level set here.
  check(`table privileges ${role}.${t} == ${intended[role][t]}`, matrix[`${role}.${t}`] === intended[role][t], `actual: ${matrix[`${role}.${t}`]}`);
}
for (const role of roles) for (const t of TABLES) for (const p of ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
  check(`${role} has no ${p} on ${t}`, !(await priv(role, `public.${t}`, p)));
}
const col = async (role, t, c, p) => (await db.query(`select has_column_privilege($1, $2, $3, $4) v`, [role, `public.${t}`, c, p])).rows[0].v;
for (const c of ["source", "external_reference", "created_at", "updated_at", "completed_at"]) {
  check(`authenticated cannot INSERT tasks.${c}`, !(await col("authenticated", "tasks", c, "INSERT")));
  check(`authenticated cannot UPDATE tasks.${c}`, !(await col("authenticated", "tasks", c, "UPDATE")));
}
check("authenticated cannot UPDATE tasks.created_by", !(await col("authenticated", "tasks", "created_by", "UPDATE")));
for (const c of ["role", "title", "email"]) check(`authenticated cannot UPDATE profiles.${c}`, !(await col("authenticated", "profiles", c, "UPDATE")));
check("authenticated can UPDATE notifications.read_at only", (await col("authenticated", "notifications", "read_at", "UPDATE")) && !(await col("authenticated", "notifications", "title", "UPDATE")));

// ---------------------------------------------------------------- function privileges
const fx = async (role, sig) => (await db.query(`select has_function_privilege($1, $2, 'EXECUTE') v`, [role, sig])).rows[0].v;
check("anon cannot execute is_admin()", !(await fx("anon", "public.is_admin()")));
check("authenticated can execute is_admin() (RLS needs it)", await fx("authenticated", "public.is_admin()"));
check("anon cannot execute team_workload()", !(await fx("anon", "public.team_workload()")));
check("authenticated can execute team_workload()", await fx("authenticated", "public.team_workload()"));
for (const f of ["handle_new_user()", "guard_profile_update()", "tasks_log_activity()", "tasks_before_write()", "touch_updated_at()"]) {
  for (const r of ["anon", "authenticated"]) check(`${r} cannot execute ${f}`, !(await fx(r, `public.${f}`)));
}

// ---------------------------------------------------------------- behaviour under real roles
const A = "00000000-0000-0000-0000-00000000000a", M1 = "00000000-0000-0000-0000-0000000000b1", M2 = "00000000-0000-0000-0000-0000000000b2";
// GoTrue inserts users as supabase_auth_admin (not a superuser): the profile trigger must fire even though EXECUTE on it is revoked.
const mk = async (id, email, name) => attempt("supabase_auth_admin", null, "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)", [id, email, JSON.stringify({ full_name: name })]);
const u1 = await mk(A, "admin@example.test", "Admin");
check("a non-superuser (GoTrue) can create users and the profile trigger fires with EXECUTE revoked", u1.ok, u1.msg);
await mk(M1, "m1@example.test", "M1"); await mk(M2, "m2@example.test", "M2");
const boot = await attempt("postgres", null, "update public.profiles set role = 'admin' where id = $1", [A]);
check("first admin can be promoted by trusted maintenance with no tricks (M-2)", boot.ok, boot.msg);
if (!boot.ok) { await db.exec("set session_replication_role = replica"); await db.query("update public.profiles set role = 'admin' where id = $1", [A]); await db.exec("set session_replication_role = origin"); }
check("new users get a member profile via the trigger", (await db.query("select count(*)::int n from public.profiles where role = 'member'")).rows[0].n === 2);

const t1 = await attempt("authenticated", M1, "insert into public.tasks (title, created_by) values ('m1 task', $1) returning id", [M1]);
check("member can create a task for themselves", t1.ok, t1.msg);
const ev = await db.query("select event_type from public.activity_events order by created_at");
check("the definer trigger wrote the task_created event (owner can write despite no insert policy)", ev.rows.some((r) => r.event_type === "task_created"));
const forged = await attempt("authenticated", M1, "insert into public.tasks (title, created_by, source, external_reference) values ('forged', $1, 'email', 'x') returning source", [M1]);
check("member CANNOT forge source/external_reference on insert", !forged.ok && forged.code === "42501", forged.ok ? `succeeded with source=${forged.rows[0].source}` : forged.msg);
const reown = await attempt("authenticated", M1, "update public.tasks set created_by = $1 where title = 'm1 task'", [M2]);
check("member CANNOT change created_by", !reown.ok && reown.code === "42501", reown.ok ? "succeeded" : reown.msg);
const okUpd = await attempt("authenticated", M1, "update public.tasks set status = 'in_progress' where title = 'm1 task'");
check("member can update their task's status", okUpd.ok && okUpd.n === 1, okUpd.msg);
const done = await attempt("authenticated", M1, "update public.tasks set status = 'completed' where title = 'm1 task' returning completed_at");
check("completing a task sets completed_at via the trigger (no column grant needed)", done.ok && done.rows[0]?.completed_at, done.msg);
const other = await attempt("authenticated", M2, "select title from public.tasks");
check("RLS: member 2 does not see member 1's task", other.ok && other.rows.length === 0, other.msg);
const adminSees = await attempt("authenticated", A, "select title from public.tasks");
check("RLS: admin sees every task", adminSees.ok && adminSees.rows.length === 1, adminSees.msg);
const trunc = await attempt("authenticated", M1, "truncate public.tasks");
check("authenticated CANNOT TRUNCATE tasks", !trunc.ok && trunc.code === "42501", trunc.ok ? "TRUNCATE SUCCEEDED (RLS does not stop it)" : trunc.msg);
check("tasks survived", (await db.query("select count(*)::int n from public.tasks")).rows[0].n === 1);
const truncA = await attempt("anon", null, "truncate public.activity_events");
check("anon CANNOT TRUNCATE activity_events", !truncA.ok && truncA.code === "42501", truncA.ok ? "TRUNCATE SUCCEEDED" : truncA.msg);
const anonSel = await attempt("anon", null, "select * from public.tasks");
check("anon cannot read tasks at all (permission denied, not just zero rows)", !anonSel.ok && anonSel.code === "42501", anonSel.ok ? `read ${anonSel.rows.length} rows` : anonSel.msg);
const anonProf = await attempt("anon", null, "select * from public.profiles");
check("anon cannot read profiles", !anonProf.ok && anonProf.code === "42501");
const selfRole = await attempt("authenticated", M1, "update public.profiles set role = 'admin' where id = $1", [M1]);
check("member CANNOT promote themselves (privilege-level)", !selfRole.ok, selfRole.ok ? "succeeded" : selfRole.msg);
const selfEmail = await attempt("authenticated", M1, "update public.profiles set email = 'x@example.test' where id = $1", [M1]);
check("member CANNOT rewrite their email", !selfEmail.ok, selfEmail.ok ? "succeeded" : selfEmail.msg);
const insEv = await attempt("authenticated", M1, "insert into public.activity_events (event_type, description) values ('workflow_failed','forged')");
check("authenticated CANNOT insert activity events", !insEv.ok && insEv.code === "42501");
const intUpd = await attempt("authenticated", A, "update public.integrations set status = 'connected' where provider = 'gmail'");
check("even an admin session CANNOT mark an integration connected through the API", !intUpd.ok && intUpd.code === "42501", intUpd.ok ? "succeeded (H-2)" : intUpd.msg);
const svcEv = await attempt("service_role", null, "insert into public.activity_events (event_type, description) values ('email_received','synthetic')");
check("service_role can write activity events", svcEv.ok, svcEv.msg);
const svcInt = await attempt("service_role", null, "update public.integrations set status = 'connected' where provider = 'gmail'");
check("service_role can update integration status", svcInt.ok, svcInt.msg);
const svcTask = await attempt("service_role", null, "insert into public.tasks (title, source, external_reference) values ('from worker', 'email', 'ref1') returning id");
check("service_role can create tasks (workers) incl. source/external_reference", svcTask.ok, svcTask.msg);
const svcDel = await attempt("service_role", null, "delete from public.tasks");
check("service_role CANNOT bulk-delete tasks", !svcDel.ok && svcDel.code === "42501", svcDel.ok ? "succeeded" : svcDel.msg);
const svcTrunc = await attempt("service_role", null, "truncate public.tasks");
check("service_role CANNOT truncate tasks", !svcTrunc.ok && svcTrunc.code === "42501");
const tw = await attempt("authenticated", M1, "select * from public.team_workload()");
check("authenticated can call team_workload()", tw.ok, tw.msg);
const twA = await attempt("anon", null, "select * from public.team_workload()");
check("anon cannot call team_workload()", !twA.ok && twA.code === "42501");
const notif = await db.query("select count(*)::int n from public.notifications");
void notif;

function print() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== ${label}: ${results.length - bad.length}/${results.length} checks pass (apply as ${applyAs}) ===`);
  for (const r of results) if (!r.ok || process.env.VERBOSE) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
  if (process.env.MATRIX) for (const [k, v] of Object.entries(matrix)) console.log(`  ${k.padEnd(32)} ${v}`);
}
print();
process.exit(results.some((r) => !r.ok) ? 1 : 0);
