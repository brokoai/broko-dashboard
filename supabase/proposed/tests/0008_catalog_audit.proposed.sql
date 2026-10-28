-- ============================================================================================
-- READ-ONLY catalog audit of migration 0008 (chat audit) on the DEVELOPMENT project (broko-dev).
-- Run in the Supabase SQL Editor AFTER 0001 and 0008 are applied. Only SELECTs inside a DO block: it writes nothing.
-- It raises an exception naming the first failed check; NOTICE 'ALL 0008 CATALOG CHECKS PASSED' means none failed.
-- Complements (does not replace) supabase/proposed/tests/0008_chat_audit.pglite.mjs, which proves the same rules by behaviour.
-- ============================================================================================
do $$
declare
  r text; p text; c text; n int;
  api text[] := array['anon', 'authenticated', 'service_role'];
begin
  -- 1. RLS on, not forced, owned by postgres; exactly two policies, both authenticated-only.
  if not (select relrowsecurity from pg_class where oid = 'public.chat_audit'::regclass) then raise exception 'FAILED: RLS off on chat_audit'; end if;
  if (select relforcerowsecurity from pg_class where oid = 'public.chat_audit'::regclass) then raise exception 'FAILED: FORCE RLS on chat_audit'; end if;
  if (select relowner::regrole::text from pg_class where oid = 'public.chat_audit'::regclass) <> 'postgres' then raise exception 'FAILED: chat_audit not owned by postgres'; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'chat_audit';
  if n <> 2 then raise exception 'FAILED: expected 2 policies on chat_audit, found %', n; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_audit' and roles::text <> '{authenticated}') then
    raise exception 'FAILED: a chat_audit policy is not authenticated-only'; end if;

  -- 1b. Read access is administrators only: the select policy tests is_admin() and never the caller's own id.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_audit' and policyname = 'chat_audit_read' and cmd = 'SELECT'
                   and qual like '%is_admin()%' and qual not like '%auth.uid()%' and qual not like '%actor_id%') then
    raise exception 'FAILED: chat_audit_read is not admin-only'; end if;

  -- 2. Nobody holds TRUNCATE / REFERENCES / TRIGGER / UPDATE / DELETE; anon and service_role hold nothing at all.
  foreach r in array api loop
    foreach p in array array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(r, 'public.chat_audit', p) then raise exception 'FAILED: % has table-level % on chat_audit', r, p; end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'service_role'] loop
    foreach p in array array['SELECT', 'INSERT'] loop
      if has_table_privilege(r, 'public.chat_audit', p) then raise exception 'FAILED: % has % on chat_audit', r, p; end if;
    end loop;
  end loop;
  if has_table_privilege('authenticated', 'public.chat_audit', 'INSERT') then raise exception 'FAILED: authenticated has table-level INSERT (columns only)'; end if;
  if not has_table_privilege('authenticated', 'public.chat_audit', 'SELECT') then raise exception 'FAILED: authenticated cannot read chat_audit (RLS limits the rows)'; end if;

  -- 3. Column privileges: no column of chat_audit can be updated by any API role; created_at, id and organization_id cannot be inserted.
  for c in select column_name from information_schema.columns where table_schema = 'public' and table_name = 'chat_audit' loop
    foreach r in array api loop
      if has_column_privilege(r, 'public.chat_audit', c, 'UPDATE') then raise exception 'FAILED: % can update chat_audit.%', r, c; end if;
    end loop;
  end loop;
  foreach c in array array['id', 'created_at', 'organization_id'] loop
    if has_column_privilege('authenticated', 'public.chat_audit', c, 'INSERT') then raise exception 'FAILED: authenticated can insert chat_audit.%', c; end if;
  end loop;
  foreach c in array array['actor_id', 'intent', 'outcome', 'project_id', 'source_ids', 'record_count', 'has_evidence', 'used_model', 'latency_ms'] loop
    if not has_column_privilege('authenticated', 'public.chat_audit', c, 'INSERT') then raise exception 'FAILED: authenticated cannot insert chat_audit.% (the app needs it)', c; end if;
  end loop;

  -- 4. The shape stays content-free: the only text-like columns are intent, outcome and source_ids (no free text, no jsonb).
  if (select string_agg(column_name, ',' order by column_name) from information_schema.columns
       where table_schema = 'public' and table_name = 'chat_audit' and data_type in ('text', 'ARRAY', 'jsonb', 'character varying', 'json')) <> 'intent,outcome,source_ids' then
    raise exception 'FAILED: chat_audit has an unexpected text-like column (it must stay metadata-only)'; end if;

  -- 5. The burst-cap trigger exists and its function is not executable by any API role.
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.chat_audit'::regclass and t.tgname = 'chat_audit_burst_cap' and not t.tgisinternal) then
    raise exception 'FAILED: burst-cap trigger missing'; end if;
  foreach r in array api loop
    if has_function_privilege(r, 'public.chat_audit_burst_cap()', 'EXECUTE') then raise exception 'FAILED: % can execute chat_audit_burst_cap()', r; end if;
  end loop;
  -- DEFINER on purpose: members cannot read the table, so an invoker trigger would count zero rows and the cap would never fire.
  if not (select prosecdef from pg_proc where oid = 'public.chat_audit_burst_cap()'::regprocedure) then raise exception 'FAILED: burst cap must be SECURITY DEFINER (members cannot read the table)'; end if;
  if (select relowner::regrole::text from pg_class c where c.oid = 'public.chat_audit'::regclass) <> (select proowner::regrole::text from pg_proc where oid = 'public.chat_audit_burst_cap()'::regprocedure) then
    raise exception 'FAILED: burst cap is not owned by the table owner'; end if;
  if not exists (select 1 from pg_proc f, unnest(f.proconfig) cfg where f.oid = 'public.chat_audit_burst_cap()'::regprocedure and cfg in ('search_path=""', 'search_path=')) then
    raise exception 'FAILED: burst cap lacks an empty search_path'; end if;

  -- The cap is serialized per user (advisory lock) so concurrent requests cannot both pass at 119, and only for the caller's own rows.
  if position('pg_advisory_xact_lock' in pg_get_functiondef('public.chat_audit_burst_cap()'::regprocedure)) = 0 then
    raise exception 'FAILED: burst cap takes no advisory lock (concurrent requests could exceed it)'; end if;
  if position('auth.uid()' in pg_get_functiondef('public.chat_audit_burst_cap()'::regprocedure)) = 0 then
    raise exception 'FAILED: burst cap does not restrict the lock to the caller own rows'; end if;

  raise notice 'ALL 0008 CATALOG CHECKS PASSED';
end $$;
