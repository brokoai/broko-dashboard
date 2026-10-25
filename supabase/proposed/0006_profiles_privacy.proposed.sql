-- ============================================================================================
-- PROPOSED, NOT APPLIED. Fixes finding M-4: any signed-in user can read every colleague's EMAIL from public.profiles.
-- Depends on 0001 (which grants authenticated table-level SELECT on profiles).
-- Verified only on a local PostgreSQL. Needs the app change already made locally in
-- src/lib/backend/supabase/profile.ts + index.ts (the signed-in user's own email now comes from their auth session, not
-- from the shared table). Apply this ONLY together with that code, or sign-in would fail with "permission denied".
--
-- WHY A COLUMN GRANT (and not an RLS policy): RLS filters ROWS, not columns. profiles_read must stay `using (true)` so
-- assignee pickers can list names; hiding one column needs a privilege, not a policy.
--
-- BEHAVIOUR AFTER THIS FILE
--   authenticated may read: id, full_name, role, title, created_at, updated_at (every user's) and NOT email.
--   `select *` / any query naming email from profiles by a signed-in user -> permission denied.
--   The dashboard never reads email from profiles (listPeople: id, full_name; sign-in: PROFILE_COLUMNS).
--   Administrators who need an address use the Supabase dashboard or a server-side (service_role) job.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
-- On the dev project the CLI's login role (cli_login_postgres) is a member of postgres with SET but NOT INHERIT and has no
-- CREATE on schema public, so objects can only be created after SET ROLE postgres (this also makes postgres the owner).
-- The previous role is saved and restored at the end instead of `reset role`: if the CLI had already switched to postgres, a
-- plain `reset role` would drop it back to the login role and the CLI's own migration-history insert, queued after this file,
-- would fail. Saving and restoring is correct whether or not the CLI switched first, and when run in the SQL editor.
select set_config('broko.prev_role', current_user, false);
set role postgres;

revoke select on public.profiles from authenticated;
grant select (id, full_name, role, title, created_at, updated_at) on public.profiles to authenticated;

-- ROLLBACK: revoke select (id, full_name, role, title, created_at, updated_at) on public.profiles from authenticated;
--           grant select on public.profiles to authenticated;

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
