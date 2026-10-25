-- ============================================================================================
-- PROPOSED, NOT ENABLED, NOT APPLIED ANYWHERE. Do not move into supabase/migrations/ without an explicit decision.
-- Tested only on a local PostgreSQL (supabase/proposed/tests/0001_least_privilege.pglite.mjs, scenario DEFAULT_PRIVS).
--
-- WHAT THIS CHANGES
-- Supabase ships the project with "default privileges" (pg_default_acl, read from the dev project): every table, sequence
-- and function that role `postgres` creates in schema `public` is automatically granted to anon, authenticated and
-- service_role (tables: arwdDxtm = all, including TRUNCATE; sequences: rwU; functions: EXECUTE). RLS does not stop TRUNCATE.
-- This file removes those automatic grants for FUTURE objects, so a new object is invisible to the API until a migration
-- grants access on purpose (fail closed).
--
-- EXACTLY WHICH FUTURE OBJECTS ARE AFFECTED
--   creator role  : `postgres` only. This is the role used by the dashboard's Table Editor and SQL editor, by
--                   `supabase db push --db-url ...postgres...`, and (after `set role postgres` in 0001) by CLI migrations.
--   schema        : `public` only.
--   object kinds  : tables (incl. partitioned tables and views), sequences, functions/procedures.
--   roles revoked : anon, authenticated, service_role.
--
-- WHAT IT DOES NOT CHANGE
--   * Existing objects (0001 revokes and re-grants its own explicitly).
--   * Other schemas (auth, storage, realtime, graphql, graphql_public, extensions, vault): they keep Supabase's defaults.
--   * Objects created by `supabase_admin` (the platform itself; it also has default entries in public, but changing them
--     needs membership in supabase_admin, which a migration does not have). Such objects are rare in `public`.
--   * The implicit EXECUTE that PUBLIC gets on every new function. It can only be removed globally (no IN SCHEMA form), which
--     would also strip it from future extension functions that column defaults rely on. So every function migration must
--     still `revoke all on function ... from public` explicitly (tests/sql-security.test.ts enforces this).
--   * Objects created by the CLI's temporary login role (cli_login_postgres): no default entries exist for that role, so
--     its objects get no API grants anyway. 0001 sets the role to postgres first so ownership is permanent.
--
-- CONSEQUENCES TO ACCEPT
--   * A table created in the dashboard Table Editor will answer 403/"permission denied" through the API until a migration
--     grants access. Serial/identity columns also need `grant usage on sequence ...` for any role that inserts.
--   * RECOMMENDED MODEL: ALL schema changes go through reviewed migrations; each migration that creates an object ends with
--     its explicit grants. Use the Table Editor only for scratch work on a throwaway project.
--
-- HOW LEGITIMATE APPLICATION ACCESS IS GRANTED AFTER THIS (template for every new object, in the same migration)
--   create table public.example (...);
--   alter table public.example enable row level security;             -- (the platform event trigger also does this)
--   create policy ... on public.example for select to authenticated using (...);
--   revoke all on public.example from public, anon, authenticated, service_role;   -- harmless once defaults are gone; explicit is safer
--   grant select on public.example to authenticated;                   -- only what the dashboard needs
--   grant insert (col_a, col_b), update (col_a) on public.example to authenticated;   -- column lists for client writes
--   grant select, insert, update on public.example to service_role;    -- only what server workers need
--   create function public.do_thing() ... security definer set search_path = '' ...;
--   revoke all on function public.do_thing() from public, anon, authenticated, service_role;
--   grant execute on function public.do_thing() to authenticated;      -- or service_role for worker-only functions
--
-- ROLLBACK (not an ownership fix; only restores the platform default): alter default privileges for role postgres in schema
-- public grant all on tables to anon, authenticated, service_role; (and the same for sequences and functions).
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
-- On the dev project the CLI's login role (cli_login_postgres) is a member of postgres with SET but NOT INHERIT and has no
-- CREATE on schema public, so objects can only be created after SET ROLE postgres (this also makes postgres the owner).
-- The previous role is saved and restored at the end instead of `reset role`: if the CLI had already switched to postgres, a
-- plain `reset role` would drop it back to the login role and the CLI's own migration-history insert, queued after this file,
-- would fail. Saving and restoring is correct whether or not the CLI switched first, and when run in the SQL editor.
select set_config('broko.prev_role', current_user, false);
set role postgres;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role;

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
