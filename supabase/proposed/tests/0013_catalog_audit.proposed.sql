-- READ-ONLY catalog audit for migration 0013 (organizational memory). Changes nothing. Run in the Supabase SQL editor (or any read-only session) on broko-dev
-- AFTER 0013 is applied. It returns one row per check; every row must say ok = true. It never reads page text or records.
-- Expected: 4 tables (RLS on, one admin-only SELECT policy each), 11 functions (all SECURITY DEFINER, search_path empty, none executable by anon/public/
-- service_role, 10 executable by authenticated, the guard by nobody), no INSERT/UPDATE/DELETE/TRUNCATE grant to any API role.
with
tables as (select unnest(array['org_source_docs','org_entities','org_entity_events','org_ingest_runs']) as name),
funcs as (select unnest(array['org_memory_guard','org_memory_upsert_doc','org_memory_record_failure','org_memory_archive_doc','org_memory_mark_extracted','org_memory_upsert_entity','org_memory_stale_missing','org_memory_review','org_memory_mark_promotion','org_memory_run_start','org_memory_run_finish']) as name),
roles as (select unnest(array['anon','authenticated','service_role']) as r),
t as (
  select t.name, c.oid is not null as exists_, coalesce(c.relrowsecurity, false) as rls,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.name) as policies,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.name and p.cmd = 'SELECT' and p.roles = '{authenticated}' and p.qual like '%is_admin%') as admin_select_policies
  from tables t left join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
),
f as (
  select f.name, p.oid is not null as exists_, coalesce(p.prosecdef, false) as secdef, coalesce(p.proconfig::text like '%search_path=%', false) as has_search_path, p.oid as oid
  from funcs f left join pg_proc p on p.proname = f.name and p.pronamespace = 'public'::regnamespace
)
select 'table ' || name as object, 'table' as kind, exists_ and rls and policies = 1 and admin_select_policies = 1
         and not exists (select 1 from roles r where has_table_privilege(r.r, 'public.' || t.name, 'insert') or has_table_privilege(r.r, 'public.' || t.name, 'update') or has_table_privilege(r.r, 'public.' || t.name, 'delete') or has_table_privilege(r.r, 'public.' || t.name, 'truncate'))
         and not has_table_privilege('anon', 'public.' || t.name, 'select') and not has_table_privilege('service_role', 'public.' || t.name, 'select')
         and has_table_privilege('authenticated', 'public.' || t.name, 'select') as ok,
       format('exists=%s rls=%s policies=%s admin_select=%s anon_select=%s auth_select=%s service_select=%s', exists_, rls, policies, admin_select_policies,
              has_table_privilege('anon', 'public.' || t.name, 'select'), has_table_privilege('authenticated', 'public.' || t.name, 'select'), has_table_privilege('service_role', 'public.' || t.name, 'select')) as detail
from t
union all
select 'function ' || name, 'function', exists_ and secdef and has_search_path
         and not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('service_role', oid, 'execute')
         and has_function_privilege('authenticated', oid, 'execute') = (name <> 'org_memory_guard'),
       format('exists=%s security_definer=%s search_path_set=%s anon_exec=%s auth_exec=%s service_exec=%s', exists_, secdef, has_search_path,
              case when oid is null then null else has_function_privilege('anon', oid, 'execute') end, case when oid is null then null else has_function_privilege('authenticated', oid, 'execute') end, case when oid is null then null else has_function_privilege('service_role', oid, 'execute') end)
from f
union all
select 'index org_ingest_runs_one_running', 'index', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'org_ingest_runs_one_running' and indexdef ilike '%unique%' and indexdef ilike '%finished_at is null%'), 'single-slot partial unique index'
union all
select 'indexes (6 expected)', 'index', (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('org_source_docs_sync_idx','org_entities_type_idx','org_entities_queue_idx','org_entity_events_entity_idx','org_ingest_runs_one_running','org_ingest_runs_recent_idx')) = 6, 'named indexes present'
union all
select 'migration history 0013', 'history', exists (select 1 from supabase_migrations.schema_migrations where version = '0013'), 'history row'
order by 2, 1;
