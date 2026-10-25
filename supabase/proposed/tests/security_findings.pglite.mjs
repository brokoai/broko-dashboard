// LOCAL ONLY. Executes the remaining security findings on a local PostgreSQL and shows BEFORE (exposed) and AFTER (enforced
// locally) for each. Never connects to any remote database. Nothing here proves the same on a real Supabase project.
//   npm install --no-save @electric-sql/pglite     (temporary, not saved to package.json)
//   node supabase/proposed/tests/security_findings.pglite.mjs
// Env: APPLY_AS=cli_login_postgres, NO_EVENT_TRIGGER=1, VERBOSE=1 (same meaning as 0001_least_privilege.pglite.mjs).
import { fileURLToPath } from "node:url";
import { IDS, createEnv } from "./lib/pglite_env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)); // supabase/
const F = {
  m0001: `${root}migrations/0001_init.sql`,
  p0002: `${root}proposed/0002_hardening.proposed.sql`,
  p0003: `${root}proposed/0003_ai_brain.proposed.sql`,
  p0004: `${root}proposed/0004_ai_jobs.proposed.sql`,
  p0005: `${root}proposed/0005_default_privileges.proposed.sql`,
  p0006: `${root}proposed/0006_profiles_privacy.proposed.sql`,
  assert0001: `${root}proposed/tests/0001_privileges.proposed.sql`,
};
let failures = 0;
const finish = (label, env) => { if (!env.print(label)) failures++; };

// ======================================================================= 1. repo-shaped payloads execute
{
  const env = await createEnv();
  const { check, attempt, denied } = env;
  await env.apply([F.m0001]); await env.seedUsers();
  const ins = await attempt("authenticated", IDS.m1, "insert into public.tasks (title, description, status, priority, assigned_to, due_at, created_by) values ('t', null, 'open', 'medium', null, null, $1) returning id", [IDS.m1]);
  check("repo createTask payload (7 columns) executes as authenticated", ins.ok, ins.msg);
  const id = ins.rows?.[0]?.id;
  const up6 = await attempt("authenticated", IDS.m1, "update public.tasks set title='t2', description=null, status='in_progress', priority='high', assigned_to=null, due_at=null where id = $1 returning id", [id]);
  check("repo updateTask payload (6 columns) executes", up6.ok && up6.n === 1, up6.msg);
  const up1 = await attempt("authenticated", IDS.m1, "update public.tasks set status='completed' where id = $1 returning completed_at", [id]);
  check("repo setTaskStatus payload executes and the trigger sets completed_at", up1.ok && !!up1.rows[0]?.completed_at, up1.msg);
  const sel = await attempt("authenticated", IDS.m1, "select t.*, p.full_name as assignee_name from public.tasks t left join public.profiles p on p.id = t.assigned_to");
  check("repo task read (tasks.* + assignee full_name embed) executes", sel.ok && sel.rows.length === 1, sel.msg);
  for (const [name, q] of [
    ["listPeople (id, full_name)", "select id, full_name from public.profiles order by full_name"],
    ["activity feed read incl. metadata", "select id, event_type, description, status, actor_id, related_task_id, created_at, metadata from public.activity_events"],
    ["integrations read", "select provider, status, last_sync_at, last_error from public.integrations"],
    ["notifications read", "select id, title, created_at, read_at from public.notifications"],
    ["team_workload()", "select * from public.team_workload()"],
  ]) { const r = await attempt("authenticated", IDS.m1, q); check(`repo read executes: ${name}`, r.ok, r.msg); }
  const hostile = await attempt("authenticated", IDS.m1, "insert into public.tasks (title, created_by, source) values ('x', $1, 'email')", [IDS.m1]);
  check("a payload that adds `source` is refused (fails closed, 42501)", denied(hostile), hostile.msg);
  finish("1. repo payloads on 0001", env);
}

// ======================================================================= 2. M-4 profiles email exposure
{
  const before = await createEnv();
  await before.apply([F.m0001]); await before.seedUsers();
  const leak = await before.attempt("authenticated", IDS.m1, "select email from public.profiles where id <> $1", [IDS.m1]);
  before.check("BEFORE 0006 (OPEN, expected): a member can read colleagues' emails", leak.ok && leak.rows.length === 2, leak.msg);
  finish("2a. M-4 before (0001 alone)", before);

  const after = await createEnv();
  const { check, attempt, denied } = after;
  await after.apply([F.m0001, F.p0006]); await after.seedUsers();
  const e1 = await attempt("authenticated", IDS.m1, "select email from public.profiles");
  check("AFTER 0006: a member cannot read any email (42501)", denied(e1), e1.msg);
  const star = await attempt("authenticated", IDS.m1, "select * from public.profiles");
  check("AFTER 0006: select * is refused as well (so a careless query fails loudly)", denied(star), star.msg);
  const asAdmin = await attempt("authenticated", IDS.admin, "select email from public.profiles");
  check("AFTER 0006: even an admin SESSION cannot read emails through the API (admins use the dashboard/service role)", denied(asAdmin), asAdmin.msg);
  const names = await attempt("authenticated", IDS.m1, "select id, full_name, role, title from public.profiles order by full_name");
  check("AFTER 0006: the dashboard's profile query (PROFILE_COLUMNS) still works for everyone", names.ok && names.rows.length === 3, names.msg);
  const embed = await attempt("authenticated", IDS.m1, "insert into public.tasks (title, created_by, assigned_to) values ('mine', $1, $1) returning id", [IDS.m1]);
  const join = await attempt("authenticated", IDS.m1, "select t.title, p.full_name from public.tasks t left join public.profiles p on p.id = t.assigned_to");
  check("AFTER 0006: the task assignee embed (profiles.full_name) still works", embed.ok && join.ok && join.rows[0]?.full_name === "M1", join.msg);
  const svc = await attempt("service_role", null, "select email from public.profiles");
  check("AFTER 0006: service_role (trusted server code) can still read emails", svc.ok && svc.rows.length === 3, svc.msg);
  const upd = await attempt("authenticated", IDS.m1, "update public.profiles set email = 'x@example.test' where id = $1", [IDS.m1]);
  check("AFTER 0006: a member still cannot rewrite their email", denied(upd), upd.msg);
  finish("2b. M-4 after (0001 + 0006)", after);
}

// ======================================================================= 3. H-1 members reassigning tasks
{
  const before = await createEnv();
  await before.apply([F.m0001]); await before.seedUsers();
  const t = await before.attempt("authenticated", IDS.m1, "insert into public.tasks (title, created_by, assigned_to) values ('mine', $1, $1) returning id", [IDS.m1]);
  const hand = await before.attempt("authenticated", IDS.m1, "update public.tasks set assigned_to = $2 where id = $1 returning assigned_to", [t.rows?.[0]?.id, IDS.m2]);
  before.check("BEFORE 0002 (OPEN, expected): a member can hand a task to someone else with a plain UPDATE", hand.ok && hand.n === 1, hand.msg);
  finish("3a. H-1 before (0001 alone)", before);

  for (const [label, files] of [["3b. H-1 after 0002", [F.m0001, F.p0002]], ["3c. H-1 after 0002 + 0003 (invoker guard)", [F.m0001, F.p0002, F.p0003]]]) {
    const env = await createEnv();
    const { check, attempt } = env;
    await env.apply(files); await env.seedUsers();
    const mine = await attempt("authenticated", IDS.m1, "insert into public.tasks (title, created_by, assigned_to) values ('mine', $1, $1) returning id", [IDS.m1]);
    const id = mine.rows?.[0]?.id;
    check("a member can create a task assigned to themselves", mine.ok, mine.msg);
    const give = await attempt("authenticated", IDS.m1, "update public.tasks set assigned_to = $2 where id = $1", [id, IDS.m2]);
    check("a member CANNOT reassign it to someone else (UPDATE)", !give.ok && give.code === "42501", give.ok ? "succeeded" : `${give.code} ${give.msg}`);
    const other = await attempt("authenticated", IDS.m1, "insert into public.tasks (title, created_by, assigned_to) values ('x', $1, $2)", [IDS.m1, IDS.m2]);
    check("a member CANNOT create a task assigned to someone else (INSERT)", !other.ok, other.msg);
    const un = await attempt("authenticated", IDS.m1, "update public.tasks set assigned_to = null where id = $1 returning assigned_to", [id]);
    check("a member can unassign (matches the app rule canAssignTo)", un.ok && un.n === 1, un.msg);
    const self = await attempt("authenticated", IDS.m1, "update public.tasks set assigned_to = $2 where id = $1 returning assigned_to", [id, IDS.m1]);
    check("a member can assign to themselves", self.ok, self.msg);
    const adm = await attempt("authenticated", IDS.admin, "update public.tasks set assigned_to = $2 where id = $1 returning assigned_to", [id, IDS.m2]);
    check("an administrator CAN assign to anyone", adm.ok && adm.n === 1, adm.msg);
    const forge = await attempt("authenticated", IDS.m1, "insert into public.tasks (title, created_by, source) values ('f', $1, 'email')", [IDS.m1]);
    check("source/external_reference stay server-controlled", !forge.ok && forge.code === "42501", forge.msg);
    finish(label, env);
  }
}

// ======================================================================= 4. first-admin bootstrap and integration status
{
  const env = await createEnv();
  const { check, attempt, denied } = env;
  await env.apply([F.m0001]);
  const mk = (id, e, n) => attempt("supabase_auth_admin", null, "insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3::jsonb)", [id, e, JSON.stringify({ full_name: n })]);
  await mk(IDS.admin, "admin@example.test", "Admin"); await mk(IDS.m1, "m1@example.test", "M1");
  const boot = await attempt("postgres", null, "update public.profiles set role = 'admin' where id = $1", [IDS.admin]);
  check("first admin: promotion from the SQL editor / owner works (M-2 fixed in 0001)", boot.ok, boot.msg);
  const bootSvc = await attempt("service_role", null, "update public.profiles set role = 'admin' where id = $1", [IDS.m1]);
  check("first admin: promotion by the service role works too", bootSvc.ok, bootSvc.msg);
  await attempt("service_role", null, "update public.profiles set role = 'member' where id = $1", [IDS.m1]);
  const self = await attempt("authenticated", IDS.m1, "update public.profiles set role = 'admin' where id = $1", [IDS.m1]);
  check("a member CANNOT promote themselves through the API", denied(self), self.msg);
  const adm = await attempt("authenticated", IDS.admin, "update public.profiles set role = 'member' where id = $1", [IDS.m1]);
  check("not even an admin session can change roles through the API (server-side only)", denied(adm), adm.msg);
  const intAdm = await attempt("authenticated", IDS.admin, "update public.integrations set status = 'connected', last_sync_at = now() where provider = 'microsoft_outlook'");
  check("an admin session CANNOT mark an integration connected (H-2)", denied(intAdm), intAdm.msg);
  const intSvc = await attempt("service_role", null, "update public.integrations set status = 'connected', last_sync_at = now() where provider = 'microsoft_outlook'");
  check("only the service role (a verification worker) can set integration status", intSvc.ok, intSvc.msg);
  const rows = await attempt("authenticated", IDS.m1, "select provider, status from public.integrations where provider = 'microsoft_outlook'");
  check("everyone signed in can still READ integration status", rows.ok && rows.rows[0]?.status === "connected", rows.msg);
  // L-6: the last administrator cannot be demoted or deleted by ANY path, trusted ones included (0001 profiles_keep_an_admin).
  const lastErr = (r) => !r.ok && r.code === "23514";
  const adminIds = async () => (await env.db.query("select id from public.profiles where role = 'admin'")).rows.map((r) => r.id);
  await attempt("postgres", null, "update public.profiles set role = 'member' where id <> $1 and role = 'admin'", [IDS.admin]);
  check("L-6 setup: exactly one administrator", (await adminIds()).length === 1, JSON.stringify(await adminIds()));
  check("L-6: the service role cannot demote the last admin", lastErr(await attempt("service_role", null, "update public.profiles set role = 'member' where role = 'admin'")));
  check("L-6: the SQL editor / owner cannot demote the last admin", lastErr(await attempt("postgres", null, "update public.profiles set role = 'member' where id = $1", [IDS.admin])));
  check("L-6: the last admin's profile cannot be deleted", lastErr(await attempt("postgres", null, "delete from public.profiles where id = $1", [IDS.admin])));
  check("L-6: deleting the last admin's AUTH user is refused (cascade fires the row trigger)", lastErr(await attempt("supabase_auth_admin", null, "delete from auth.users where id = $1", [IDS.admin])));
  check("L-6: a refused removal changed nothing", (await adminIds()).length === 1 && (await env.db.query("select 1 from auth.users where id = $1", [IDS.admin])).rows.length === 1);
  await attempt("postgres", null, "update public.profiles set role = 'admin' where id = $1", [IDS.m1]);
  check("L-6: with a second admin, the first CAN be demoted", (await attempt("service_role", null, "update public.profiles set role = 'member' where id = $1", [IDS.admin])).ok);
  check("L-6: ...and the new sole admin is protected in turn", lastErr(await attempt("postgres", null, "update public.profiles set role = 'member' where id = $1", [IDS.m1])));
  check("L-6: a non-admin's auth user can still be deleted (no over-blocking)", (await attempt("supabase_auth_admin", null, "delete from auth.users where id = $1", [IDS.admin])).ok);
  finish("4. bootstrap, integration status and last administrator (0001)", env);

  const g = await createEnv();
  await g.apply([F.m0001, F.p0002]);
  await g.attempt("supabase_auth_admin", null, "insert into auth.users (id, email, raw_user_meta_data) values ($1,'a@example.test','{}'::jsonb)", [IDS.admin]);
  const boot2 = await g.attempt("postgres", null, "update public.profiles set role = 'admin' where id = $1", [IDS.admin]);
  g.check("with 0002 applied, trusted promotion still works", boot2.ok, boot2.msg);
  const svc2 = await g.attempt("service_role", null, "update public.integrations set status = 'connected' where provider = 'gmail'");
  g.check("with 0002's integrations_guard, the service role can still set status", svc2.ok, svc2.msg);
  finish("4b. same with 0002", g);
}

// ======================================================================= 5. default privileges (0005)
{
  for (const [label, order] of [["5a. 0005 applied BEFORE 0001 (recommended on a fresh project)", [F.p0005, F.m0001]], ["5b. 0005 applied AFTER 0001", [F.m0001, F.p0005]]]) {
    const env = await createEnv();
    const { db, check, attempt } = env;
    await env.apply(order); await env.seedUsers();
    // 0001 is unaffected: the whole read-only assertion script from the dev-project workflow still passes.
    try { await db.exec((await import("node:fs")).readFileSync(F.assert0001, "utf8")); check("0001's privilege assertions still pass", true); } catch (e) { check("0001's privilege assertions still pass", false, String(e.message).slice(0, 150)); }
    // A table, a sequence and a function created later by postgres (as the Table Editor / SQL editor would).
    await db.exec("set role postgres");
    await db.exec("create table public.later_table (id serial primary key, note text); alter table public.later_table enable row level security;");
    await db.exec("create function public.later_fn() returns int language sql as $$ select 1 $$;");
    await db.exec("reset role");
    for (const r of ["anon", "authenticated", "service_role"]) {
      const has = (await db.query("select has_table_privilege($1, 'public.later_table', 'SELECT') s, has_table_privilege($1, 'public.later_table', 'TRUNCATE') t, has_sequence_privilege($1, 'public.later_table_id_seq', 'USAGE') q", [r])).rows[0];
      check(`NEW table/sequence: ${r} gets nothing automatically`, !has.s && !has.t && !has.q, JSON.stringify(has));
    }
    const sel = await attempt("authenticated", IDS.m1, "select * from public.later_table");
    check("NEW table is invisible through the API until a migration grants access (fail closed)", !sel.ok && sel.code === "42501", sel.msg);
    const pub = (await db.query("select has_function_privilege('anon', 'public.later_fn()', 'EXECUTE') v")).rows[0].v;
    check("NEW function: PUBLIC still gets EXECUTE (by design: removing it is global); every function migration must revoke it", pub === true, `anon can execute: ${pub}`);
    // The documented template then grants access explicitly.
    await db.exec("set role postgres");
    await db.exec("revoke all on function public.later_fn() from public, anon, authenticated, service_role; grant execute on function public.later_fn() to authenticated;");
    await db.exec("grant select on public.later_table to authenticated; create policy later_read on public.later_table for select to authenticated using (true);");
    await db.exec("reset role");
    const ok = await attempt("authenticated", IDS.m1, "select * from public.later_table");
    check("TEMPLATE: explicit grant + policy gives the dashboard exactly the access it needs", ok.ok, ok.msg);
    const fnAnon = await attempt("anon", null, "select public.later_fn()");
    const fnAuth = await attempt("authenticated", IDS.m1, "select public.later_fn()");
    check("TEMPLATE: the function is callable by authenticated only", fnAuth.ok && !fnAnon.ok, `${fnAuth.msg ?? ""} ${fnAnon.msg ?? ""}`);
    const ins = await attempt("authenticated", IDS.m1, "insert into public.later_table (note) values ('x')");
    check("TEMPLATE: no INSERT without an explicit grant (serial sequences need USAGE too)", !ins.ok && ins.code === "42501", ins.msg);
    finish(label, env);
  }
  // Contrast: WITHOUT 0005, a later table is auto-granted everything (the platform default).
  const env = await createEnv();
  await env.apply([F.m0001]);
  await env.db.exec("set role postgres"); await env.db.exec("create table public.later_table (id int); "); await env.db.exec("reset role");
  const t = (await env.db.query("select has_table_privilege('anon','public.later_table','TRUNCATE') v")).rows[0].v;
  env.check("WITHOUT 0005 (current state): a later table is auto-granted incl. TRUNCATE to anon (this is what 0005 prevents)", t === true, `anon TRUNCATE: ${t}`);
  finish("5c. contrast without 0005", env);
}

process.exit(failures ? 1 : 0);
