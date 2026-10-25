-- ============================================================================================
-- READ-ONLY verification of 0001's least-privilege model. NOT RUN against any remote database yet.
-- Safe by construction: only SELECTs inside DO blocks; it writes, creates and drops nothing.
-- Run it on the approved development project AFTER 0001 has been applied (supabase db query --linked -f <this file>).
-- It raises an exception naming the first violated check; ending with NOTICE 'ALL PRIVILEGE CHECKS PASSED' means none failed.
-- The same intent is exercised locally by supabase/proposed/tests/0001_least_privilege.pglite.mjs (real PostgreSQL, real roles).
-- ============================================================================================

do $$
declare
  t text; r text; p text; f text; bad text := '';
  tables text[] := array['profiles', 'tasks', 'activity_events', 'notifications', 'integrations'];
  api_roles text[] := array['anon', 'authenticated', 'service_role'];
begin
  -- 1. Every table has RLS enabled (the platform's rls_auto_enable trigger swallows its own failures, so never rely on it),
  --    is NOT forced (SECURITY DEFINER triggers must still write), and is owned by postgres (not the CLI's temporary role).
  foreach t in array tables loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'CHECK FAILED: RLS is off on %', t; end if;
    if (select relforcerowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'CHECK FAILED: FORCE RLS on %', t; end if;
    if (select relowner::regrole::text from pg_class where oid = ('public.' || t)::regclass) <> 'postgres' then
      raise exception 'CHECK FAILED: % is not owned by postgres', t; end if;
  end loop;

  -- 2. No API role holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any table (RLS does not stop TRUNCATE).
  foreach t in array tables loop foreach r in array api_roles loop
    foreach p in array array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege(r, 'public.' || t, p) then raise exception 'CHECK FAILED: % has % on %', r, p, t; end if;
    end loop;
  end loop; end loop;

  -- 3. anon has nothing. authenticated and service_role have exactly the intended table-level privileges.
  foreach t in array tables loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege('anon', 'public.' || t, p) then raise exception 'CHECK FAILED: anon has % on %', p, t; end if;
      if p <> 'SELECT' and has_table_privilege('authenticated', 'public.' || t, p) then raise exception 'CHECK FAILED: authenticated has table-level % on % (columns only)', p, t; end if;
      if p = 'DELETE' and has_table_privilege('service_role', 'public.' || t, p) then raise exception 'CHECK FAILED: service_role can DELETE from %', t; end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then raise exception 'CHECK FAILED: authenticated cannot read %', t; end if;
  end loop;
  if not (has_table_privilege('service_role', 'public.activity_events', 'INSERT') and has_table_privilege('service_role', 'public.integrations', 'UPDATE')
          and has_table_privilege('service_role', 'public.tasks', 'INSERT') and has_table_privilege('service_role', 'public.notifications', 'INSERT')) then
    raise exception 'CHECK FAILED: service_role lacks a privilege the workers need'; end if;

  -- 4. Column-level limits for authenticated.
  foreach f in array array['source', 'external_reference', 'created_at', 'updated_at', 'completed_at'] loop
    if has_column_privilege('authenticated', 'public.tasks', f, 'INSERT') or has_column_privilege('authenticated', 'public.tasks', f, 'UPDATE') then
      raise exception 'CHECK FAILED: authenticated can write tasks.%', f; end if;
  end loop;
  if has_column_privilege('authenticated', 'public.tasks', 'created_by', 'UPDATE') then raise exception 'CHECK FAILED: created_by is updatable'; end if;
  foreach f in array array['title', 'description', 'status', 'priority', 'assigned_to', 'due_at'] loop
    if not (has_column_privilege('authenticated', 'public.tasks', f, 'INSERT') and has_column_privilege('authenticated', 'public.tasks', f, 'UPDATE')) then
      raise exception 'CHECK FAILED: authenticated cannot write tasks.% (the dashboard needs it)', f; end if;
  end loop;
  foreach f in array array['role', 'title', 'email', 'full_name'] loop
    if has_column_privilege('authenticated', 'public.profiles', f, 'UPDATE') then raise exception 'CHECK FAILED: authenticated can update profiles.%', f; end if;
  end loop;
  if not has_column_privilege('authenticated', 'public.notifications', 'read_at', 'UPDATE') or has_column_privilege('authenticated', 'public.notifications', 'title', 'UPDATE') then
    raise exception 'CHECK FAILED: notifications column privileges'; end if;

  -- 5. Functions: trigger functions are not callable by any API role; is_admin / team_workload only by signed-in users.
  foreach f in array array['handle_new_user()', 'guard_profile_update()', 'tasks_log_activity()', 'tasks_before_write()', 'touch_updated_at()'] loop
    foreach r in array api_roles loop
      if has_function_privilege(r, 'public.' || f, 'EXECUTE') then raise exception 'CHECK FAILED: % can execute %', r, f; end if;
    end loop;
  end loop;
  foreach f in array array['is_admin()', 'team_workload()'] loop
    if has_function_privilege('anon', 'public.' || f, 'EXECUTE') or has_function_privilege('service_role', 'public.' || f, 'EXECUTE') then raise exception 'CHECK FAILED: % too widely executable', f; end if;
    if not has_function_privilege('authenticated', 'public.' || f, 'EXECUTE') then raise exception 'CHECK FAILED: authenticated cannot execute %', f; end if;
  end loop;

  -- 6. Every SECURITY DEFINER function in our objects is owned by postgres and pins search_path to '' (nothing can shadow a name).
  for f, bad in
    select p.proname, coalesce(p.proconfig::text, '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and p.proname <> 'rls_auto_enable'      -- rls_auto_enable is the platform's, not ours
  loop
    -- proconfig::text stores the quotes escaped, so strip backslashes (chr(92)) before comparing.
    if replace(bad, chr(92), '') not like '%search_path=""%' then
      raise exception 'CHECK FAILED: definer function % does not pin an empty search_path (%)', f, bad;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname <> 'rls_auto_enable' and p.proowner::regrole::text <> 'postgres') then
    raise exception 'CHECK FAILED: a function is not owned by postgres'; end if;

  -- 7. Expected policy set (a missing or extra policy is a review item).
  if (select count(*) from pg_policies where schemaname = 'public') <> 11 then
    raise exception 'CHECK FAILED: expected 11 policies, found %', (select count(*) from pg_policies where schemaname = 'public'); end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and ('anon' = any (roles) or 'public' = any (roles))) then
    raise exception 'CHECK FAILED: a policy applies to anon/public'; end if;
  raise notice 'ALL PRIVILEGE CHECKS PASSED';
end $$;
