// LOCAL ONLY. Shared bootstrap for the PGlite-based SQL security tests. Never connects to any remote database.
// Imitates the parts of Supabase that matter for privileges: roles, an auth schema stub, the dev project's default privileges
// (copied from its pg_default_acl) and the platform's rls_auto_enable event trigger (copied verbatim).
// Requires a temporary, unsaved install:  npm install --no-save @electric-sql/pglite
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";

export const IDS = {
  admin: "00000000-0000-0000-0000-00000000000a",
  m1: "00000000-0000-0000-0000-0000000000b1",
  m2: "00000000-0000-0000-0000-0000000000b2",
};

export async function createEnv({ applyAs = process.env.APPLY_AS ?? "postgres", noEventTrigger = !!process.env.NO_EVENT_TRIGGER } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

  await db.exec(`
    create role supabase_auth_admin nologin;
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    create schema extensions;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
    alter table auth.users owner to supabase_auth_admin; grant all on auth.users to postgres;
    -- Like Supabase's own auth.uid(): the legacy per-claim setting OR the JSON claims setting (PostgREST sets the latter).
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant all on schema auth to supabase_auth_admin;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path to 'pg_catalog' as $f$
    declare cmd record; tbl name;
    begin
      for cmd in select * from pg_event_trigger_ddl_commands() where command_tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') and object_type in ('table','partitioned table')
      loop
        if cmd.schema_name is not null and cmd.schema_name in ('public') then
          begin
            select c.relname into tbl from pg_catalog.pg_class c where c.oid = cmd.objid;
            execute format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
          exception when others then raise log 'rls_auto_enable: failed on %', cmd.object_identity; end;
        end if;
      end loop;
    end $f$;
  `);
  if (!noEventTrigger) {
    await db.exec(`create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') execute function public.rls_auto_enable();`);
  }

  /**
   * Apply SQL files in order the way the Supabase CLI does, per facts read from the dev project (broko-dev):
   *   the login role cli_login_postgres is a MEMBER of postgres with SET but NOT INHERIT, has NO CREATE on schema public,
   *   and is NOT a superuser. So a migration can only create objects after SET ROLE postgres.
   * `cliSetsRole` emulates the CLI having already issued SET SESSION ROLE postgres at connect time (unconfirmed; both are tested).
   * After each file the CLI inserts the migration into its history table in the SAME role the file left behind.
   */
  async function apply(files, { cliSetsRole = process.env.CLI_SETS_ROLE === "1", history = false } = {}) {
    const cli = applyAs;
    if (cli !== "postgres") {
      await db.exec(`create role ${cli} login noinherit; grant postgres to ${cli} with inherit false, set true;`).catch(() => {});
      await db.exec(`set session authorization ${cli}`);          // the SESSION user is the login role, as with the real CLI
      if (cliSetsRole) await db.exec("set session role postgres");
      if (history) {
        await db.exec("set role postgres");
        await db.exec("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key);");
        if (!cliSetsRole) await db.exec(`alter table supabase_migrations.schema_migrations owner to ${cli}; grant usage, create on schema supabase_migrations to ${cli}`);
        await db.exec(cliSetsRole ? "set session role postgres" : "reset role");
      }
    }
    try {
      for (const f of files) {
        const name = f.split(/[\/]/).pop();
        const before = (await db.query("select current_user u")).rows[0].u;
        try { await db.exec(readFileSync(f, "utf8")); check(`applies: ${name}`, true); }
        catch (e) { check(`applies: ${name}`, false, String(e.message).slice(0, 200)); return false; }
        const after = (await db.query("select current_user u")).rows[0].u;
        if (cli !== "postgres") {
          check(`${name}: role after the file equals the role before it (${before})`, after === before, `before=${before} after=${after}`);
          if (history) {
            try { await db.query("insert into supabase_migrations.schema_migrations (version) values ($1)", [name]); check(`${name}: the CLI's history insert still works afterwards`, true); }
            catch (e) { check(`${name}: the CLI's history insert still works afterwards`, false, `as ${after}: ${String(e.message).slice(0, 90)}`); return false; }
          }
        }
      }
      return true;
    } finally {
      // Back to the bootstrap superuser. (PGlite's RESET SESSION AUTHORIZATION does not return to it, so set it explicitly.)
      if (cli !== "postgres") { await db.exec("reset role"); await db.exec("set session authorization postgres"); }
    }
  }

  const asRole = async (role, uid, fn) => {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? ""]);
    try { return await fn(); } finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub', '', false)"); }
  };
  const attempt = async (role, uid, stmt, params = []) => {
    try { const r = await asRole(role, uid, () => db.query(stmt, params)); return { ok: true, rows: r.rows, n: r.affectedRows ?? r.rows.length }; }
    catch (e) { return { ok: false, code: e.code, msg: String(e.message).slice(0, 140) }; }
  };
  const denied = (r) => !r.ok && r.code === "42501";

  /** Creates the three users through GoTrue's role (a non-superuser) and promotes the admin by trusted maintenance. */
  async function seedUsers() {
    const mk = (id, email, name) => attempt("supabase_auth_admin", null, "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)", [id, email, JSON.stringify({ full_name: name })]);
    await mk(IDS.admin, "admin@example.test", "Admin"); await mk(IDS.m1, "m1@example.test", "M1"); await mk(IDS.m2, "m2@example.test", "M2");
    return attempt("postgres", null, "update public.profiles set role = 'admin' where id = $1", [IDS.admin]);
  }

  function print(label) {
    const bad = results.filter((r) => !r.ok);
    console.log(`\n=== ${label}: ${results.length - bad.length}/${results.length} checks pass (apply as ${applyAs}) ===`);
    for (const r of results) if (!r.ok || process.env.VERBOSE) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
    return bad.length === 0;
  }
  return { db, check, results, apply, asRole, attempt, denied, seedUsers, print, applyAs };
}
