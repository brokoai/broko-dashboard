-- ============================================================================================
-- READ-ONLY catalog audit of the DRAFT migration 0011 (knowledge guards). Run it only AFTER 0011 has been applied with the owner's
-- approval, on the development project first (`supabase db query --linked -f`). Only SELECTs inside a DO block: it writes nothing.
-- Raises an exception naming the first failed check; NOTICE 'ALL 0011 CATALOG CHECKS PASSED' means none failed.
-- Run 0009_catalog_audit.proposed.sql as well: it must still pass after 0011.
-- NOT RUN against any remote project (0011 is not applied anywhere).
-- ============================================================================================
do $$
declare
  f text; r text; c text; n int;
  fns text[] := array['public.knowledge_can_replace(uuid,text,uuid,text)', 'public.knowledge_review(uuid,text,text)', 'public.knowledge_redact(uuid,text)'];
begin
  -- 1. The new functions: SECURITY DEFINER, owned by the table owner, empty search_path, executable by authenticated only.
  foreach f in array fns loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then raise exception 'FAILED: % is not SECURITY DEFINER', f; end if;
    if (select proowner::regrole::text from pg_proc where oid = f::regprocedure) <> 'postgres' then raise exception 'FAILED: % is not owned by postgres', f; end if;
    if not exists (select 1 from pg_proc x, unnest(x.proconfig) cfg where x.oid = f::regprocedure and cfg in ('search_path=""', 'search_path=')) then raise exception 'FAILED: % lacks an empty search_path', f; end if;
    if exists (select 1 from pg_proc x, aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a where x.oid = f::regprocedure and a.grantee = 0) then raise exception 'FAILED: % is executable by PUBLIC', f; end if;
    foreach r in array array['anon', 'service_role'] loop
      if has_function_privilege(r, f, 'EXECUTE') then raise exception 'FAILED: % can execute %', r, f; end if;
    end loop;
    if not has_function_privilege('authenticated', f, 'EXECUTE') then raise exception 'FAILED: authenticated cannot execute % (administrators and the policy need it)', f; end if;
  end loop;

  -- 2. Both administrator functions check the caller's session, not an argument.
  foreach f in array array['public.knowledge_review(uuid,text,text)', 'public.knowledge_redact(uuid,text)'] loop
    if position('is_admin()' in pg_get_functiondef(f::regprocedure)) = 0 or position('auth.uid()' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception 'FAILED: % does not check the caller is an administrator', f; end if;
  end loop;
  if position('prior.topic is distinct from k.topic' in pg_get_functiondef('public.knowledge_review(uuid,text,text)'::regprocedure)) = 0 or position('prior.scope <> k.scope' in pg_get_functiondef('public.knowledge_review(uuid,text,text)'::regprocedure)) = 0 then
    raise exception 'FAILED: knowledge_review does not refuse a replacement of a different scope, project or topic (0011 not applied?)'; end if;

  -- 3. The insert policy uses the scope-aware helper, and is still authenticated-only, own-rows-only and proposal-only.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'knowledge_items' and policyname = 'knowledge_items_insert' and cmd = 'INSERT' and roles::text = '{authenticated}'
                   and with_check like '%knowledge_can_replace(supersedes_id, scope, project_id, topic)%' and with_check like '%author_id = auth.uid()%'
                   and with_check like '%''proposed''%' and with_check like '%reviewed_by IS NULL%') then
    raise exception 'FAILED: knowledge_items_insert does not use knowledge_can_replace with scope, project and topic (0011 not applied?)'; end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'knowledge_items') <> 2 then raise exception 'FAILED: expected 2 policies on knowledge_items'; end if;

  -- 4. The removal marker exists, is not client-writable, and no role gained UPDATE or DELETE.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'knowledge_items' and column_name = 'redacted_at') then raise exception 'FAILED: knowledge_items.redacted_at is missing'; end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_column_privilege(r, 'public.knowledge_items', 'redacted_at', 'INSERT') or has_column_privilege(r, 'public.knowledge_items', 'redacted_at', 'UPDATE') then raise exception 'FAILED: % can write knowledge_items.redacted_at', r; end if;
    foreach c in array array['UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(r, 'public.knowledge_items', c) or has_table_privilege(r, 'public.knowledge_events', c) then raise exception 'FAILED: % has % on the knowledge tables', r, c; end if;
    end loop;
  end loop;

  -- 5. The history vocabulary: exactly one check on knowledge_events.action, and it accepts 'redacted'.
  select count(*) into n from pg_constraint where conrelid = 'public.knowledge_events'::regclass and contype = 'c'
    and conkey = array[(select attnum from pg_attribute where attrelid = 'public.knowledge_events'::regclass and attname = 'action')];
  if n <> 1 then raise exception 'FAILED: expected exactly one CHECK on knowledge_events.action, found %', n; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.knowledge_events'::regclass and conname = 'knowledge_events_action_check' and pg_get_constraintdef(oid) like '%''redacted''%') then
    raise exception 'FAILED: knowledge_events.action does not accept ''redacted'' (0011 not applied?)'; end if;

  raise notice 'ALL 0011 CATALOG CHECKS PASSED';
end $$;
