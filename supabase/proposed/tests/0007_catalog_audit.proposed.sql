-- ============================================================================================
-- READ-ONLY catalog audit of migration 0007 (Pre-Construction) on the DEVELOPMENT project (broko-dev).
-- Run in the Supabase SQL Editor AFTER 0001, 0002, 0006, 0007 are applied. Only SELECTs inside DO blocks: it writes nothing.
-- It raises an exception naming the first failed check; NOTICE 'ALL 0007 CATALOG CHECKS PASSED' means none failed.
-- Complements (does not replace) the live script, which proves the same rules through the real API as admin and member.
-- ============================================================================================
do $$
declare
  t text; r text; p text; n int;
  tabs text[] := array['precon_projects', 'precon_documents', 'precon_chunks', 'precon_inventory', 'precon_audit'];
  api text[] := array['anon', 'authenticated', 'service_role'];
begin
  -- 1. RLS on, not forced, owned by postgres.
  foreach t in array tabs loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAILED: RLS off on %', t; end if;
    if (select relforcerowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAILED: FORCE RLS on %', t; end if;
    if (select relowner::regrole::text from pg_class where oid = ('public.' || t)::regclass) <> 'postgres' then raise exception 'FAILED: % not owned by postgres', t; end if;
    -- every table has at least one policy, and no policy is PUBLIC or anon
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t;
    if n = 0 then raise exception 'FAILED: no policies on %', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and (roles::text not like '{authenticated}')) then
      raise exception 'FAILED: a policy on % is not authenticated-only', t; end if;
  end loop;

  -- 2. anon holds nothing; nobody holds TRUNCATE / REFERENCES / TRIGGER; authenticated has no table-level write (columns only) except documented DELETEs.
  foreach t in array tabs loop
    foreach r in array api loop
      foreach p in array array['TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, 'public.' || t, p) then raise exception 'FAILED: % has % on %', r, p, t; end if;
      end loop;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege('anon', 'public.' || t, p) then raise exception 'FAILED: anon has % on %', p, t; end if;
      if has_table_privilege('service_role', 'public.' || t, p) then raise exception 'FAILED: service_role has % on % (not granted by 0007)', p, t; end if;
    end loop;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT') or has_table_privilege('authenticated', 'public.' || t, 'UPDATE') then
      raise exception 'FAILED: authenticated has table-level write on %', t; end if;
  end loop;
  -- projects and inventory are never deletable by clients; audit is insert/select only
  foreach t in array array['precon_projects', 'precon_inventory', 'precon_audit'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'DELETE') then raise exception 'FAILED: authenticated can DELETE from %', t; end if;
  end loop;

  -- 3. unit_number: no SELECT or UPDATE-by-member path, only the admin function; INSERT is column-granted to authenticated (RLS limits it to admins).
  if has_column_privilege('authenticated', 'public.precon_inventory', 'unit_number', 'SELECT') then raise exception 'FAILED: authenticated can SELECT unit_number'; end if;
  if has_column_privilege('authenticated', 'public.precon_inventory', 'unit_number', 'UPDATE') then raise exception 'FAILED: authenticated can UPDATE unit_number'; end if;
  if has_column_privilege('anon', 'public.precon_inventory', 'unit_number', 'SELECT') then raise exception 'FAILED: anon can SELECT unit_number'; end if;
  if not has_column_privilege('authenticated', 'public.precon_inventory', 'price', 'SELECT') then raise exception 'FAILED: authenticated cannot read price'; end if;

  -- 4. protected document columns: storage_path / sha256 are never selectable? (storage_path is read by the server only via the repo; confirm what the grant says)
  --    Informational: reported below, not asserted, because the table-level SELECT grant is intentional.

  -- 5. functions: unit-number function is SECURITY DEFINER with an empty search_path and is admin-gated; search function is SECURITY INVOKER.
  if not (select prosecdef from pg_proc where oid = 'public.precon_unit_numbers(uuid)'::regprocedure) then raise exception 'FAILED: precon_unit_numbers is not SECURITY DEFINER'; end if;
  if (select prosecdef from pg_proc where oid = 'public.precon_search_chunks(text,uuid,integer)'::regprocedure) then raise exception 'FAILED: precon_search_chunks must be SECURITY INVOKER'; end if;
  foreach t in array array['public.precon_unit_numbers(uuid)', 'public.precon_search_chunks(text,uuid,integer)'] loop
    if not exists (select 1 from pg_proc f, unnest(f.proconfig) c where f.oid = t::regprocedure and c in ('search_path=""', 'search_path=')) then
      raise exception 'FAILED: % lacks an empty search_path', t; end if;
    if has_function_privilege('anon', t, 'EXECUTE') then raise exception 'FAILED: anon can execute %', t; end if;
    if has_function_privilege('service_role', t, 'EXECUTE') then raise exception 'FAILED: service_role can execute %', t; end if;
    if not has_function_privilege('authenticated', t, 'EXECUTE') then raise exception 'FAILED: authenticated cannot execute %', t; end if;
  end loop;
  if position('is_admin()' in pg_get_functiondef('public.precon_unit_numbers(uuid)'::regprocedure)) = 0 then raise exception 'FAILED: precon_unit_numbers is not admin-gated'; end if;

  -- 6. storage: bucket exists, is PRIVATE, has a size limit and an allow-list; policies exist for authenticated only; none for anon/public.
  if not exists (select 1 from storage.buckets where id = 'precon-files') then raise exception 'FAILED: bucket precon-files missing'; end if;
  if (select public from storage.buckets where id = 'precon-files') then raise exception 'FAILED: bucket precon-files is PUBLIC'; end if;
  if (select file_size_limit from storage.buckets where id = 'precon-files') is null then raise exception 'FAILED: bucket has no size limit'; end if;
  if coalesce(array_length((select allowed_mime_types from storage.buckets where id = 'precon-files'), 1), 0) = 0 then raise exception 'FAILED: bucket has no MIME allow-list'; end if;
  if exists (select 1 from storage.buckets where id = 'precon-files' and 'image/svg+xml' = any (allowed_mime_types) or 'text/html' = any (allowed_mime_types)) then
    raise exception 'FAILED: bucket allows svg or html'; end if;
  select count(*) into n from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'precon_files_%';
  if n <> 3 then raise exception 'FAILED: expected 3 precon_files_* storage policies, found %', n; end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'precon_files_%' and roles::text <> '{authenticated}') then
    raise exception 'FAILED: a precon_files policy is not authenticated-only'; end if;
  -- every precon_files policy must reference the bucket (a policy without the bucket test would cover other buckets)
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'precon_files_%'
             and coalesce(qual, '') || coalesce(with_check, '') not like '%precon-files%') then
    raise exception 'FAILED: a precon_files policy does not restrict to the precon-files bucket'; end if;

  -- 7. nothing else in storage.objects is wide open to anon (platform-wide sanity check)
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and (roles::text like '%anon%' or roles::text like '%public%')) then
    raise notice 'NOTE: a storage.objects policy applies to anon/public (not from 0007). Review it.'; end if;

  raise notice 'ALL 0007 CATALOG CHECKS PASSED';
end $$;

-- Informational (read-only): the policy text and the document-table grants, to eyeball.
select tablename, policyname, cmd, roles, qual, with_check from pg_policies
 where (schemaname = 'public' and tablename like 'precon\_%') or (schemaname = 'storage' and policyname like 'precon\_files\_%')
 order by schemaname, tablename, policyname;
select column_name, privilege_type from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'precon_documents' and grantee = 'authenticated' order by privilege_type, column_name;
