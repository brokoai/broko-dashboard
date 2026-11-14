-- ============================================================================================
-- READ-ONLY catalog audit of migrations 0009 (knowledge) and 0010 (chat audit vocabulary).
-- Run in the Supabase SQL Editor (or `supabase db query --linked -f`) on the DEVELOPMENT project ONLY AFTER 0001, 0007, 0008, 0009 and 0010
-- have been applied there with the owner's approval. Only SELECTs inside a DO block: it writes nothing.
-- It raises an exception naming the first failed check; NOTICE 'ALL 0009/0010 CATALOG CHECKS PASSED' means none failed.
-- Complements (does not replace) supabase/proposed/tests/0009_knowledge.pglite.mjs, which proves the same rules by behaviour.
-- NOT RUN against any remote project yet.
-- ============================================================================================
do $$
declare
  r text; p text; c text; t text; n int; f text;
  api text[] := array['anon', 'authenticated', 'service_role'];
  tables text[] := array['knowledge_items', 'knowledge_events', 'answer_feedback'];
begin
  -- 1. RLS on, not forced, owned by postgres; the expected policies, all authenticated-only.
  foreach t in array tables loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAILED: RLS off on %', t; end if;
    if (select relforcerowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FAILED: FORCE RLS on %', t; end if;
    if (select relowner::regrole::text from pg_class where oid = ('public.' || t)::regclass) <> 'postgres' then raise exception 'FAILED: % not owned by postgres', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and roles::text <> '{authenticated}') then raise exception 'FAILED: a % policy is not authenticated-only', t; end if;
  end loop;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'knowledge_items') <> 2 then raise exception 'FAILED: expected 2 policies on knowledge_items'; end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'knowledge_events') <> 1 then raise exception 'FAILED: expected 1 policy on knowledge_events'; end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'answer_feedback') <> 2 then raise exception 'FAILED: expected 2 policies on answer_feedback'; end if;

  -- 2. Policy content: administrators / the author / approved-and-current for reads; submissions only as yourself and only as a proposal.
  if not exists (select 1 from pg_policies where tablename = 'knowledge_items' and policyname = 'knowledge_items_read' and cmd = 'SELECT'
                   and qual like '%is_admin()%' and qual like '%author_id = auth.uid()%' and qual like '%''approved''%' and qual like '%expires_at%' and qual like '%precon_projects%') then
    raise exception 'FAILED: knowledge_items_read is not (admin or author or approved-and-current-in-visible-project)'; end if;
  if not exists (select 1 from pg_policies where tablename = 'knowledge_items' and policyname = 'knowledge_items_insert' and cmd = 'INSERT'
                   and with_check like '%author_id = auth.uid()%' and with_check like '%''proposed''%' and with_check like '%reviewed_by IS NULL%') then
    raise exception 'FAILED: knowledge_items_insert does not force author = caller and status = proposed'; end if;
  foreach t in array array['knowledge_events', 'answer_feedback'] loop
    if not exists (select 1 from pg_policies where tablename = t and cmd = 'SELECT' and qual like '%is_admin()%' and qual not like '%auth.uid()%' and qual not like '%actor_id%') then
      raise exception 'FAILED: the % read policy is not admin-only', t; end if;
  end loop;
  if not exists (select 1 from pg_policies where tablename = 'answer_feedback' and policyname = 'answer_feedback_insert' and with_check like '%actor_id = auth.uid()%') then
    raise exception 'FAILED: answer_feedback_insert does not force actor = caller'; end if;

  -- 3. Nobody holds TRUNCATE / REFERENCES / TRIGGER / UPDATE / DELETE; anon and service_role hold nothing at all.
  foreach t in array tables loop
    foreach r in array api loop
      foreach p in array array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(r, 'public.' || t, p) then raise exception 'FAILED: % has table-level % on %', r, p, t; end if;
      end loop;
      for c in select column_name from information_schema.columns where table_schema = 'public' and table_name = t loop
        if has_column_privilege(r, 'public.' || t, c, 'UPDATE') then raise exception 'FAILED: % can update %.%', r, t, c; end if;
      end loop;
    end loop;
    foreach r in array array['anon', 'service_role'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT') or has_any_column_privilege(r, 'public.' || t, 'INSERT') then raise exception 'FAILED: % has access to %', r, t; end if;
    end loop;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT') then raise exception 'FAILED: authenticated has table-level INSERT on % (columns only)', t; end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then raise exception 'FAILED: authenticated cannot read % (RLS limits the rows)', t; end if;
  end loop;
  if has_any_column_privilege('authenticated', 'public.knowledge_events', 'INSERT') then raise exception 'FAILED: authenticated can write knowledge_events directly'; end if;

  -- 4. Insertable columns: exactly what the app needs. Status, reviewer, timestamps, id and organization_id are never client-writable.
  foreach c in array array['kind', 'scope', 'project_id', 'title', 'body', 'topic', 'author_id', 'source_type', 'source_ref', 'supersedes_id', 'expires_at'] loop
    if not has_column_privilege('authenticated', 'public.knowledge_items', c, 'INSERT') then raise exception 'FAILED: authenticated cannot insert knowledge_items.% (the app needs it)', c; end if;
  end loop;
  foreach c in array array['id', 'organization_id', 'status', 'effective_from', 'created_at', 'updated_at', 'reviewed_by', 'reviewed_at', 'review_note'] loop
    if has_column_privilege('authenticated', 'public.knowledge_items', c, 'INSERT') then raise exception 'FAILED: authenticated can insert knowledge_items.% (must be server-controlled)', c; end if;
  end loop;
  foreach c in array array['actor_id', 'rating', 'reason', 'intent', 'source_ids'] loop
    if not has_column_privilege('authenticated', 'public.answer_feedback', c, 'INSERT') then raise exception 'FAILED: authenticated cannot insert answer_feedback.%', c; end if;
  end loop;
  foreach c in array array['id', 'organization_id', 'created_at'] loop
    if has_column_privilege('authenticated', 'public.answer_feedback', c, 'INSERT') then raise exception 'FAILED: authenticated can insert answer_feedback.%', c; end if;
  end loop;

  -- 5. Feedback stays content-free: the only text-like columns are intent, reason, rating and source_ids (no free text, no jsonb).
  if (select string_agg(column_name, ',' order by column_name) from information_schema.columns
       where table_schema = 'public' and table_name = 'answer_feedback' and data_type in ('text', 'ARRAY', 'jsonb', 'character varying', 'json')) <> 'intent,rating,reason,source_ids' then
    raise exception 'FAILED: answer_feedback has an unexpected text-like column (it must stay metadata-only)'; end if;

  -- 6. Triggers exist.
  foreach c in array array['knowledge_items_burst_cap', 'knowledge_log_submitted', 'knowledge_items_touch'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'public.knowledge_items'::regclass and tgname = c and not tgisinternal) then raise exception 'FAILED: trigger % missing', c; end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.answer_feedback'::regclass and tgname = 'answer_feedback_burst_cap' and not tgisinternal) then raise exception 'FAILED: feedback burst-cap trigger missing'; end if;

  -- 7. Functions: SECURITY DEFINER, owned by the table owner, empty search_path; trigger functions are executable by no API role; the
  --    review function is executable by authenticated only (it checks is_admin() itself) and by nobody via PUBLIC.
  foreach f in array array['public.knowledge_items_burst_cap()', 'public.answer_feedback_burst_cap()', 'public.knowledge_log_submitted()', 'public.knowledge_review(uuid,text,text)', 'public.knowledge_replaceable(uuid)'] loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then raise exception 'FAILED: % is not SECURITY DEFINER', f; end if;
    if (select proowner::regrole::text from pg_proc where oid = f::regprocedure) <> 'postgres' then raise exception 'FAILED: % is not owned by postgres', f; end if;
    if not exists (select 1 from pg_proc x, unnest(x.proconfig) cfg where x.oid = f::regprocedure and cfg in ('search_path=""', 'search_path=')) then raise exception 'FAILED: % lacks an empty search_path', f; end if;
    if exists (select 1 from pg_proc x, aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a where x.oid = f::regprocedure and a.grantee = 0) then raise exception 'FAILED: % is executable by PUBLIC', f; end if;
    foreach r in array array['anon', 'service_role'] loop
      if has_function_privilege(r, f, 'EXECUTE') then raise exception 'FAILED: % can execute %', r, f; end if;
    end loop;
    if f not in ('public.knowledge_review(uuid,text,text)', 'public.knowledge_replaceable(uuid)') and has_function_privilege('authenticated', f, 'EXECUTE') then raise exception 'FAILED: authenticated can execute trigger function %', f; end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.knowledge_review(uuid,text,text)', 'EXECUTE') then raise exception 'FAILED: authenticated cannot execute knowledge_review (administrators call it through the API)'; end if;
  if position('is_admin()' in pg_get_functiondef('public.knowledge_review(uuid,text,text)'::regprocedure)) = 0
     or position('auth.uid()' in pg_get_functiondef('public.knowledge_review(uuid,text,text)'::regprocedure)) = 0 then
    raise exception 'FAILED: knowledge_review does not check the caller is an administrator'; end if;
  foreach f in array array['public.knowledge_items_burst_cap()', 'public.answer_feedback_burst_cap()'] loop
    if position('pg_advisory_xact_lock' in pg_get_functiondef(f::regprocedure)) = 0 then raise exception 'FAILED: % takes no advisory lock', f; end if;
    if position('auth.uid()' in pg_get_functiondef(f::regprocedure)) = 0 then raise exception 'FAILED: % does not restrict the lock to the caller own rows', f; end if;
  end loop;

  -- 8. 0010: the chat audit vocabulary accepts the knowledge intent and source, with exactly one check per column and no new free-text column.
  select count(*) into n from pg_constraint where conrelid = 'public.chat_audit'::regclass and contype = 'c'
    and conkey = array[(select attnum from pg_attribute where attrelid = 'public.chat_audit'::regclass and attname = 'intent')];
  if n <> 1 then raise exception 'FAILED: expected exactly one CHECK on chat_audit.intent, found %', n; end if;
  select count(*) into n from pg_constraint where conrelid = 'public.chat_audit'::regclass and contype = 'c'
    and conkey = array[(select attnum from pg_attribute where attrelid = 'public.chat_audit'::regclass and attname = 'source_ids')];
  if n <> 1 then raise exception 'FAILED: expected exactly one CHECK on chat_audit.source_ids, found %', n; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.chat_audit'::regclass and conname = 'chat_audit_intent_check' and pg_get_constraintdef(oid) like '%''knowledge''%') then
    raise exception 'FAILED: chat_audit.intent does not accept ''knowledge'' (0010 not applied?)'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.chat_audit'::regclass and conname = 'chat_audit_source_ids_check' and pg_get_constraintdef(oid) like '%''knowledge''%') then
    raise exception 'FAILED: chat_audit.source_ids does not accept ''knowledge'' (0010 not applied?)'; end if;
  if (select string_agg(column_name, ',' order by column_name) from information_schema.columns
       where table_schema = 'public' and table_name = 'chat_audit' and data_type in ('text', 'ARRAY', 'jsonb', 'character varying', 'json')) <> 'intent,outcome,source_ids' then
    raise exception 'FAILED: chat_audit has an unexpected text-like column (it must stay metadata-only)'; end if;

  raise notice 'ALL 0009/0010 CATALOG CHECKS PASSED';
end $$;
