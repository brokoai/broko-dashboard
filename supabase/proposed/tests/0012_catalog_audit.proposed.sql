-- ============================================================================================
-- READ-ONLY catalog audit of the DRAFT migration 0012 (knowledge secret check). Run it only AFTER 0012 has been applied with the owner's
-- approval, on the development project first (`supabase db query --linked -f`). Only SELECTs and pure function calls inside a DO block:
-- it writes nothing. Raises an exception naming the first failed check; NOTICE 'ALL 0012 CATALOG CHECKS PASSED' means none failed.
-- Run 0009_catalog_audit.proposed.sql and 0011_catalog_audit.proposed.sql as well: both must still pass after 0012.
-- NOT RUN against any remote project (0012 is not applied anywhere).
-- ============================================================================================
do $$
declare
  f text; r text; n int; trg record; cols text[];
begin
  -- 1. Both functions exist, belong to postgres, and no API role (nor PUBLIC) may execute them.
  foreach f in array array['public.knowledge_secret_signal(text)', 'public.knowledge_secret_guard()', 'public.knowledge_events_secret_guard()'] loop
    if (select proowner::regrole::text from pg_proc where oid = f::regprocedure) <> 'postgres' then raise exception 'FAILED: % is not owned by postgres', f; end if;
    if not exists (select 1 from pg_proc x, unnest(x.proconfig) cfg where x.oid = f::regprocedure and cfg in ('search_path=""', 'search_path=')) then raise exception 'FAILED: % lacks an empty search_path', f; end if;
    if exists (select 1 from pg_proc x, aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a where x.oid = f::regprocedure and a.grantee = 0) then raise exception 'FAILED: % is executable by PUBLIC', f; end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'EXECUTE') then raise exception 'FAILED: % can execute %', r, f; end if;
    end loop;
  end loop;
  if not (select prosecdef from pg_proc where oid = 'public.knowledge_secret_guard()'::regprocedure) then raise exception 'FAILED: knowledge_secret_guard is not SECURITY DEFINER'; end if;
  if not (select prosecdef from pg_proc where oid = 'public.knowledge_events_secret_guard()'::regprocedure) then raise exception 'FAILED: knowledge_events_secret_guard is not SECURITY DEFINER'; end if;
  if not (select provolatile = 'i' from pg_proc where oid = 'public.knowledge_secret_signal(text)'::regprocedure) then raise exception 'FAILED: knowledge_secret_signal is not IMMUTABLE'; end if;

  -- 2. The trigger: on knowledge_items, enabled, row level, BEFORE, INSERT and UPDATE, restricted to the four text columns, calling the guard.
  select t.* into trg from pg_trigger t where t.tgrelid = 'public.knowledge_items'::regclass and t.tgname = 'knowledge_items_secret_guard' and not t.tgisinternal;
  if not found then raise exception 'FAILED: trigger knowledge_items_secret_guard is missing (0012 not applied?)'; end if;
  if trg.tgenabled <> 'O' then raise exception 'FAILED: trigger knowledge_items_secret_guard is not enabled for all sessions (tgenabled=%)', trg.tgenabled; end if;
  if trg.tgfoid <> 'public.knowledge_secret_guard()'::regprocedure then raise exception 'FAILED: the trigger calls the wrong function'; end if;
  if (trg.tgtype & 1) = 0 then raise exception 'FAILED: the trigger is not a row trigger'; end if;
  if (trg.tgtype & 2) = 0 then raise exception 'FAILED: the trigger is not BEFORE'; end if;
  if (trg.tgtype & 4) = 0 or (trg.tgtype & 16) = 0 then raise exception 'FAILED: the trigger does not cover both INSERT and UPDATE'; end if;
  if (trg.tgtype & 8) <> 0 or (trg.tgtype & 32) <> 0 then raise exception 'FAILED: the trigger covers more than INSERT and UPDATE'; end if;
  select array_agg(a.attname::text order by a.attname) into cols from pg_attribute a where a.attrelid = trg.tgrelid and a.attnum = any (trg.tgattr::int2[]);
  if cols is distinct from array['body', 'review_note', 'source_ref', 'title', 'topic'] then raise exception 'FAILED: the trigger watches % instead of body, review_note, source_ref, title, topic', cols; end if;

  -- 2b. The history trigger: on knowledge_events, enabled, row level, BEFORE, INSERT and UPDATE of note only, calling its guard.
  select t.* into trg from pg_trigger t where t.tgrelid = 'public.knowledge_events'::regclass and t.tgname = 'knowledge_events_secret_guard' and not t.tgisinternal;
  if not found then raise exception 'FAILED: trigger knowledge_events_secret_guard is missing (0012 not applied?)'; end if;
  if trg.tgenabled <> 'O' then raise exception 'FAILED: trigger knowledge_events_secret_guard is not enabled for all sessions (tgenabled=%)', trg.tgenabled; end if;
  if trg.tgfoid <> 'public.knowledge_events_secret_guard()'::regprocedure then raise exception 'FAILED: the history trigger calls the wrong function'; end if;
  if (trg.tgtype & 1) = 0 or (trg.tgtype & 2) = 0 or (trg.tgtype & 4) = 0 or (trg.tgtype & 16) = 0 or (trg.tgtype & 8) <> 0 or (trg.tgtype & 32) <> 0 then raise exception 'FAILED: the history trigger is not BEFORE ROW INSERT OR UPDATE'; end if;
  select array_agg(a.attname::text order by a.attname) into cols from pg_attribute a where a.attrelid = trg.tgrelid and a.attnum = any (trg.tgattr::int2[]);
  if cols is distinct from array['note'] then raise exception 'FAILED: the history trigger watches % instead of note', cols; end if;

  -- 3. The other knowledge triggers are still there (0012 must not have displaced them).
  select count(*) into n from pg_trigger where tgrelid = 'public.knowledge_items'::regclass and not tgisinternal
    and tgname in ('knowledge_items_touch', 'knowledge_items_burst_cap', 'knowledge_log_submitted', 'knowledge_items_secret_guard');
  if n <> 4 then raise exception 'FAILED: expected the 4 knowledge_items triggers, found %', n; end if;

  -- 4. The detector behaves (pure function calls; nothing is written). Secret-shaped test strings are built from parts.
  if public.knowledge_secret_signal(chr(45)||chr(45)||chr(45)||chr(45)||chr(45)||'BEGIN PRIVATE KEY'||chr(45)||chr(45)||chr(45)||chr(45)||chr(45)) is distinct from 'private_key' then raise exception 'FAILED: the detector misses a private key header'; end if;
  if public.knowledge_secret_signal('sk'||'-abcdefghijklmnop12345') is distinct from 'api_key_prefix' then raise exception 'FAILED: the detector misses an sk- key'; end if;
  if public.knowledge_secret_signal('sk'||'-abcdefghij'||chr(8203)||'klmnopqrstuv') is distinct from 'api_key_prefix' then raise exception 'FAILED: the detector can be evaded with a zero-width character'; end if;
  if public.knowledge_secret_signal('Refunds over 500 dollars need a second approver.') is not null then raise exception 'FAILED: the detector flags ordinary text'; end if;
  if public.knowledge_secret_signal(null) is not null then raise exception 'FAILED: the detector flags NULL'; end if;

  -- 5. 0012 added no privilege to anyone.
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(r, 'public.knowledge_items', 'UPDATE') or has_table_privilege(r, 'public.knowledge_items', 'DELETE') or has_table_privilege(r, 'public.knowledge_items', 'TRUNCATE') then
      raise exception 'FAILED: % gained UPDATE, DELETE or TRUNCATE on knowledge_items', r; end if;
  end loop;

  raise notice 'ALL 0012 CATALOG CHECKS PASSED';
end $$;
