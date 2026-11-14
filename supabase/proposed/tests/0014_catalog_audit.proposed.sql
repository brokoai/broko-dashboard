-- READ-ONLY catalog audit for migration 0014 (organizational relationships). Changes nothing. Run in the Supabase SQL editor (or any read-only session) on broko-dev
-- AFTER 0014 is applied. It returns one row per check; every row must say ok = true. It never reads page text or records.
-- Verifies: tables (RLS on, one admin-only SELECT policy each, no write or anon/service_role grants); functions (exist, SECURITY DEFINER, search_path EMPTY, owned by
-- postgres, not executable by PUBLIC/anon/service_role, 3 executable by authenticated and the internal endpoint helper by nobody); the EXACT constraint set
-- (CHECK, UNIQUE, PRIMARY KEY, FOREIGN KEY by name) and the definitions that matter (12-type vocabulary, evidence 1..8, not-self, inferred-is-never-high, unique key
-- order); every foreign key by exact name, target, column and ON DELETE behaviour (the Supabase adapter embeds two of them by name); the touch trigger; the six
-- indexes by definition; and the migration history row.
with
roles as (select unnest(array['anon','authenticated','service_role']) as r),
-- ---------------------------------------------------------------- tables
t as (
  select t.name, c.oid is not null as exists_, coalesce(c.relrowsecurity, false) as rls,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.name) as policies,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.name and p.cmd = 'SELECT' and p.roles = '{authenticated}' and p.qual like '%is_admin%') as admin_select_policies
  from (select unnest(array['org_relationships','org_relationship_events']) as name) t
  left join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
),
-- ---------------------------------------------------------------- functions
f as (
  select f.name, p.oid is not null as exists_, coalesce(p.prosecdef, false) as secdef,
         coalesce('search_path=""' = any (p.proconfig), false) as empty_search_path,
         coalesce(pg_get_userbyid(p.proowner) = 'postgres', false) as owned_by_postgres,
         p.oid as oid,
         case when p.oid is null then false else not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') end as no_public_exec
  from (select unnest(array['org_relationship_endpoint_ok','org_relationship_upsert','org_relationship_stale_missing','org_relationship_review']) as name) f
  left join pg_proc p on p.proname = f.name and p.pronamespace = 'public'::regnamespace
),
-- ---------------------------------------------------------------- constraints: the exact set, by name and kind
expected_c(tbl, conname, contype) as (values
  ('org_relationships', 'org_relationships_pkey', 'p'),
  ('org_relationships', 'org_relationships_from_entity_id_to_entity_id_relation_type_key', 'u'),
  ('org_relationships', 'org_relationships_relation_type_check', 'c'),
  ('org_relationships', 'org_relationships_stable_id_check', 'c'),
  ('org_relationships', 'org_relationships_evidence_check', 'c'),
  ('org_relationships', 'org_relationships_basis_check', 'c'),
  ('org_relationships', 'org_relationships_confidence_check', 'c'),
  ('org_relationships', 'org_relationships_review_status_check', 'c'),
  ('org_relationships', 'org_relationships_pending_revision_check', 'c'),
  ('org_relationships', 'org_relationships_not_self', 'c'),
  ('org_relationships', 'org_relationships_inferred_not_high', 'c'),
  ('org_relationships', 'org_relationships_source_doc_id_fkey', 'f'),
  ('org_relationships', 'org_relationships_from_entity_id_fkey', 'f'),
  ('org_relationships', 'org_relationships_to_entity_id_fkey', 'f'),
  ('org_relationship_events', 'org_relationship_events_pkey', 'p'),
  ('org_relationship_events', 'org_relationship_events_action_check', 'c'),
  ('org_relationship_events', 'org_relationship_events_note_check', 'c'),
  ('org_relationship_events', 'org_relationship_events_relationship_id_fkey', 'f'),
  ('org_relationship_events', 'org_relationship_events_actor_id_fkey', 'f')
),
actual_c as (
  select cl.relname as tbl, c.conname, c.contype::text as contype, c.oid, c.conrelid, c.confrelid, c.confdeltype::text as confdeltype, c.conkey, c.conkey as ck, pg_get_constraintdef(c.oid) as def
  from pg_constraint c join pg_class cl on cl.oid = c.conrelid
  where cl.relnamespace = 'public'::regnamespace and cl.relname in ('org_relationships','org_relationship_events') and c.contype in ('c','u','p','f')
),
cdef as (select conname, lower(def) as def from actual_c),
-- ---------------------------------------------------------------- foreign keys by exact name, target, column and ON DELETE (r = restrict, n = set null)
expected_fk(conname, tbl, col, target, ondelete) as (values
  ('org_relationships_source_doc_id_fkey', 'org_relationships', 'source_doc_id', 'org_source_docs', 'r'),
  ('org_relationships_from_entity_id_fkey', 'org_relationships', 'from_entity_id', 'org_entities', 'r'),
  ('org_relationships_to_entity_id_fkey', 'org_relationships', 'to_entity_id', 'org_entities', 'r'),
  ('org_relationship_events_relationship_id_fkey', 'org_relationship_events', 'relationship_id', 'org_relationships', 'r'),
  ('org_relationship_events_actor_id_fkey', 'org_relationship_events', 'actor_id', 'profiles', 'n')
),
fk as (
  select e.*, a.oid is not null as found,
         coalesce(a.confdeltype = e.ondelete, false) as delete_ok,
         coalesce((select cl.relname from pg_class cl where cl.oid = a.confrelid) = e.target, false) as target_ok,
         coalesce((select att.attname from pg_attribute att where att.attrelid = a.conrelid and att.attnum = a.conkey[1]) = e.col and cardinality(a.conkey) = 1, false) as col_ok
  from expected_fk e left join actual_c a on a.conname = e.conname and a.contype = 'f'
)
-- ================================================================ rows
select 'table ' || name as object, 'table' as kind, exists_ and rls and policies = 1 and admin_select_policies = 1
         and not exists (select 1 from roles r where has_table_privilege(r.r, 'public.' || t.name, 'insert') or has_table_privilege(r.r, 'public.' || t.name, 'update') or has_table_privilege(r.r, 'public.' || t.name, 'delete') or has_table_privilege(r.r, 'public.' || t.name, 'truncate'))
         and not has_table_privilege('anon', 'public.' || t.name, 'select') and not has_table_privilege('service_role', 'public.' || t.name, 'select')
         and has_table_privilege('authenticated', 'public.' || t.name, 'select') as ok,
       format('exists=%s rls=%s policies=%s admin_select=%s anon_select=%s auth_select=%s service_select=%s', exists_, rls, policies, admin_select_policies,
              has_table_privilege('anon', 'public.' || t.name, 'select'), has_table_privilege('authenticated', 'public.' || t.name, 'select'), has_table_privilege('service_role', 'public.' || t.name, 'select')) as detail
from t
union all
select 'function ' || name, 'function', exists_ and secdef and empty_search_path and owned_by_postgres and no_public_exec
         and not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('service_role', oid, 'execute')
         and has_function_privilege('authenticated', oid, 'execute') = (name <> 'org_relationship_endpoint_ok'),
       format('exists=%s security_definer=%s search_path_empty=%s owner_postgres=%s public_exec=%s anon_exec=%s auth_exec=%s service_exec=%s', exists_, secdef, empty_search_path, owned_by_postgres, not no_public_exec,
              case when oid is null then null else has_function_privilege('anon', oid, 'execute') end, case when oid is null then null else has_function_privilege('authenticated', oid, 'execute') end, case when oid is null then null else has_function_privilege('service_role', oid, 'execute') end)
from f
union all
select 'constraints ' || tb.tbl, 'constraint',
       not exists (select 1 from expected_c e where e.tbl = tb.tbl and not exists (select 1 from actual_c a where a.tbl = e.tbl and a.conname = e.conname and a.contype = e.contype))
         and not exists (select 1 from actual_c a where a.tbl = tb.tbl and not exists (select 1 from expected_c e where e.tbl = a.tbl and e.conname = a.conname and e.contype = a.contype)),
       format('missing=%s unexpected=%s',
              (select count(*) from expected_c e where e.tbl = tb.tbl and not exists (select 1 from actual_c a where a.tbl = e.tbl and a.conname = e.conname and a.contype = e.contype)),
              (select count(*) from actual_c a where a.tbl = tb.tbl and not exists (select 1 from expected_c e where e.tbl = a.tbl and e.conname = a.conname and e.contype = a.contype)))
from (select unnest(array['org_relationships','org_relationship_events']) as tbl) tb
union all
select 'constraint definitions', 'constraint',
       (select count(*) from cdef where conname = 'org_relationships_relation_type_check'
          and def like '%''owns''%' and def like '%''belongs_to''%' and def like '%''part_of''%' and def like '%''resulted_in''%' and def like '%''discussed_in''%' and def like '%''blocks''%'
          and def like '%''depends_on''%' and def like '%''committed_to''%' and def like '%''has_deadline''%' and def like '%''assigned_to''%' and def like '%''relates_to''%' and def like '%''raised_in''%') = 1
       and (select count(*) from cdef where conname = 'org_relationships_evidence_check' and def like '%cardinality(evidence)%' and def like '%1%' and def like '%8%') = 1
       and (select count(*) from cdef where conname = 'org_relationships_basis_check' and def like '%explicit%' and def like '%extracted%' and def like '%inferred%' and def not like '%unknown%') = 1
       and (select count(*) from cdef where conname = 'org_relationships_confidence_check' and def like '%high%' and def like '%medium%' and def like '%low%') = 1
       and (select count(*) from cdef where conname = 'org_relationships_review_status_check' and def like '%proposed%' and def like '%reviewed%' and def like '%rejected%') = 1
       and (select count(*) from cdef where conname = 'org_relationships_not_self' and def like '%from_entity_id%' and def like '%to_entity_id%' and def like '%<>%') = 1
       and (select count(*) from cdef where conname = 'org_relationships_inferred_not_high' and def like '%inferred%' and def like '%high%') = 1
       and (select count(*) from cdef where conname = 'org_relationships_from_entity_id_to_entity_id_relation_type_key' and def like '%unique (from_entity_id, to_entity_id, relation_type)%') = 1
       and (select count(*) from cdef where conname = 'org_relationship_events_action_check' and def like '%approve%' and def like '%reject%' and def like '%accept_revision%' and def like '%dismiss_revision%') = 1,
       'vocabulary, evidence 1..8, basis, confidence, review status, not-self, inferred-never-high, unique key order, event actions'
union all
select 'foreign key ' || conname, 'foreign key', found and delete_ok and target_ok and col_ok,
       format('found=%s target=%s column=%s on_delete_%s', found, target_ok, col_ok, case when delete_ok then 'ok' else 'WRONG' end)
from fk
union all
select 'trigger org_relationships_touch', 'trigger',
       exists (select 1 from pg_trigger g where g.tgrelid = 'public.org_relationships'::regclass and g.tgname = 'org_relationships_touch' and not g.tgisinternal
               and (g.tgtype & 2) = 2 and (g.tgtype & 16) = 16 and (g.tgtype & 1) = 1 -- BEFORE, UPDATE, FOR EACH ROW
               and g.tgfoid = 'public.touch_updated_at'::regproc),
       'before update, each row, public.touch_updated_at'
union all
select 'indexes (6 expected)', 'index', (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('org_relationships_from_idx','org_relationships_to_idx','org_relationships_doc_idx','org_relationships_type_idx','org_relationships_queue_idx','org_relationship_events_rel_idx')) = 6, 'named indexes present'
union all
select 'index definitions', 'index',
       (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'org_relationships_from_idx' and tablename = 'org_relationships' and indexdef like '%USING btree (from_entity_id)%' and indexdef not like '%UNIQUE%' and indexdef not like '% WHERE %') = 1
       and (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'org_relationships_to_idx' and tablename = 'org_relationships' and indexdef like '%USING btree (to_entity_id)%' and indexdef not like '% WHERE %') = 1
       and (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'org_relationships_doc_idx' and tablename = 'org_relationships' and indexdef like '%USING btree (source_doc_id)%' and indexdef not like '% WHERE %') = 1
       and (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'org_relationships_type_idx' and tablename = 'org_relationships' and indexdef like '%USING btree (relation_type, extracted_at DESC)%' and indexdef not like '% WHERE %') = 1
       and (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'org_relationships_queue_idx' and tablename = 'org_relationships' and indexdef like '%USING btree (review_status, extracted_at)%' and indexdef like '% WHERE %' and indexdef like '%proposed%' and indexdef like '%stale%') = 1
       and (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'org_relationship_events_rel_idx' and tablename = 'org_relationship_events' and indexdef like '%USING btree (relationship_id, created_at)%' and indexdef not like '% WHERE %') = 1,
       'columns, order, direction, partial predicate (queue index), non-unique'
union all
select 'migration history 0014', 'history', exists (select 1 from supabase_migrations.schema_migrations where version = '0014'), 'history row'
order by 2, 1;
