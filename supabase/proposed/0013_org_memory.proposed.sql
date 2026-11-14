-- ============================================================================================
-- PROPOSED, NOT APPLIED. Persistent organizational memory (Phase 2A):
--   L0  org_source_docs     authorized source documents kept as read (normalized content, numbered evidence segments, content hash)
--   L1  org_entities        PROPOSED intelligence extracted from L0 (people, decisions, tasks, ...) with the segments that support it
--       org_entity_events   append-only review history
--   L2  is NOT here: approved knowledge stays in public.knowledge_items and its approval workflow (0009). A reviewed L1 record is
--       promoted by creating a PROPOSED knowledge item through the existing submit path; this file never approves anything.
-- Depends on 0001 (public.profiles, public.is_admin(), public.touch_updated_at()) and 0009 (public.knowledge_items).
-- Additive only: no drops, no data changes. Verified ONLY on a local PostgreSQL (supabase/proposed/tests/0013_org_memory.pglite.mjs).
-- NOT run on any remote project, and nothing here has been verified against Supabase, PostgREST or a real session.
--
-- WHO CAN DO WHAT (everything is ADMINISTRATOR-only):
--   The Notion integration sees whatever was shared with Broko as a whole, not what each employee could open. Employee-level source
--   permissions therefore cannot be established, and memory derived from it is administrator-only (access_scope = 'admin'), exactly like
--   the meeting tools. Members read nothing, write nothing, and cannot call the functions.
--   read     : administrators only (row level security).
--   write    : only through the functions below, which check public.is_admin() against the caller's session (auth.uid()), never against
--              anything the caller supplies. No API role holds INSERT, UPDATE or DELETE on any table; service_role holds nothing.
--              (Ingestion therefore runs as an administrator's session. A scheduled job needs a separate, owner-approved decision.)
--   review   : org_memory_review(): approve / reject a proposed record, accept or dismiss a revision. Never edits what an approved
--              record says; a changed source parks the new extraction as a pending revision and marks the record stale.
-- Credentials: none are stored here. Source tokens never enter the database.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
select set_config('broko.prev_role', current_user, false);
set role postgres;

-- ------------------------------------------------------------------ L0: source documents
create table public.org_source_docs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('notion')),
  workspace_id text not null check (char_length(workspace_id) between 1 and 200),
  source_id text not null check (char_length(source_id) between 1 and 200),
  url text check (char_length(url) <= 500),
  title text not null check (char_length(title) <= 200),
  doc_type text not null default 'page' check (char_length(doc_type) <= 40),
  content text not null default '' check (char_length(content) <= 400000),
  segments jsonb not null default '[]'::jsonb check (jsonb_typeof(segments) = 'array'),
  coverage jsonb not null default '{}'::jsonb check (jsonb_typeof(coverage) = 'object'),
  content_hash text not null default '' check (char_length(content_hash) <= 64),
  last_edited timestamptz,
  ingested_at timestamptz not null default now(),
  owner text check (char_length(owner) <= 120),            -- only when the source states whose it is; never inferred
  access_scope text not null default 'admin' check (access_scope = 'admin'),
  sync_status text not null default 'synced' check (sync_status in ('synced', 'failed', 'archived')),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  last_error text check (last_error in ('not_connected', 'permission_denied', 'rate_limited', 'timeout', 'error')),   -- a fixed code, never a raw error
  extracted_hash text check (char_length(extracted_hash) <= 64),
  extraction_error text check (extraction_error in ('extraction_failed')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, workspace_id, source_id)
);
create index org_source_docs_sync_idx on public.org_source_docs (sync_status, attempts) where sync_status = 'failed';
create trigger org_source_docs_touch before update on public.org_source_docs for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ L1: extracted entities (PROPOSED intelligence)
create table public.org_entities (
  id uuid primary key default gen_random_uuid(),
  stable_id text not null check (char_length(stable_id) between 8 and 64),
  -- restrict: a source that still has records cannot be removed by accident (sources are archived, not deleted)
  source_doc_id uuid not null references public.org_source_docs (id) on delete restrict,
  entity_type text not null check (entity_type in ('person', 'team', 'project', 'meeting', 'decision', 'task', 'action_item', 'commitment', 'deadline', 'risk', 'blocker', 'client_requirement')),
  name text not null check (char_length(name) between 1 and 120),
  description text not null check (char_length(description) between 1 and 400),
  evidence text[] not null check (cardinality(evidence) between 1 and 8),   -- segment ids ("S4") of the source document
  basis text not null check (basis in ('explicit', 'extracted', 'inferred', 'unknown')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  owner text check (char_length(owner) <= 80),
  team text check (char_length(team) <= 80),
  due text check (char_length(due) <= 60),
  unknowns text[] not null default '{}' check (unknowns <@ array['owner', 'team', 'due', 'decision_maker']),
  extracted_at timestamptz not null default now(),
  review_status text not null default 'proposed' check (review_status in ('proposed', 'reviewed', 'rejected', 'promotion_proposed')),
  stale boolean not null default false,
  pending_revision jsonb check (pending_revision is null or jsonb_typeof(pending_revision) = 'object'),
  knowledge_item_id uuid references public.knowledge_items (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_doc_id, stable_id),
  constraint org_entities_inferred_not_high check (basis not in ('inferred', 'unknown') or confidence <> 'high'),
  constraint org_entities_unknown_has_no_owner check (basis <> 'unknown' or (owner is null and due is null)),
  constraint org_entities_promotion_has_item check (review_status <> 'promotion_proposed' or knowledge_item_id is not null)
);
create index org_entities_type_idx on public.org_entities (entity_type, extracted_at desc);
create index org_entities_queue_idx on public.org_entities (review_status, extracted_at) where review_status = 'proposed' or stale;
create trigger org_entities_touch before update on public.org_entities for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ review history (append only; written by functions only)
create table public.org_entity_events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.org_entities (id) on delete restrict,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in ('approve', 'reject', 'accept_revision', 'dismiss_revision', 'promotion_proposed')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index org_entity_events_entity_idx on public.org_entity_events (entity_id, created_at);

-- ------------------------------------------------------------------ ingestion runs (one at a time; operational outcomes)
-- A partial unique index lets at most ONE run be unfinished at a time. A run abandoned by a crashed server is taken over after 15 minutes.
-- The report holds counts and fixed codes only (never source text, titles, ids or errors).
create table public.org_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  started_by uuid references public.profiles (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  report jsonb check (report is null or jsonb_typeof(report) = 'object'),
  constraint org_ingest_runs_finished_has_status check ((finished_at is null) = (status = 'running'))
);
create unique index org_ingest_runs_one_running on public.org_ingest_runs ((true)) where finished_at is null;
create index org_ingest_runs_recent_idx on public.org_ingest_runs (started_at desc);

-- ------------------------------------------------------------------ functions (SECURITY DEFINER, empty search_path, administrators only)
create function public.org_memory_guard() returns void
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'only administrators can use organizational memory' using errcode = '42501'; end if;
end $$;

-- L0 write. Returns 'created', 'changed' (the content hash differs) or 'unchanged' (only the bookkeeping is refreshed; the stored text and its
-- extraction stay exactly as they were).
create function public.org_memory_upsert_doc(
  p_provider text, p_workspace text, p_source text, p_url text, p_title text, p_type text, p_content text, p_segments jsonb, p_coverage jsonb,
  p_hash text, p_last_edited timestamptz, p_owner text
) returns text
  language plpgsql security definer set search_path = ''
as $$
declare d public.org_source_docs;
begin
  perform public.org_memory_guard();
  select * into d from public.org_source_docs where provider = p_provider and workspace_id = p_workspace and source_id = p_source for update;
  if not found then
    insert into public.org_source_docs (provider, workspace_id, source_id, url, title, doc_type, content, segments, coverage, content_hash, last_edited, owner)
      values (p_provider, p_workspace, p_source, p_url, p_title, coalesce(p_type, 'page'), p_content, p_segments, p_coverage, p_hash, p_last_edited, p_owner);
    return 'created';
  end if;
  if d.content_hash is distinct from p_hash then
    update public.org_source_docs set url = p_url, title = p_title, doc_type = coalesce(p_type, 'page'), content = p_content, segments = p_segments, coverage = p_coverage,
      content_hash = p_hash, last_edited = p_last_edited, owner = p_owner, ingested_at = now(), sync_status = 'synced', attempts = 0, last_error = null, archived = false where id = d.id;
    return 'changed';
  end if;
  update public.org_source_docs set last_edited = p_last_edited, url = coalesce(p_url, url), ingested_at = now(), sync_status = 'synced', attempts = 0, last_error = null, archived = false where id = d.id;
  return 'unchanged';
end $$;

-- A source that could not be read: a fixed failure code and a counter, never the raw error. A source never read leaves a placeholder with no content.
create function public.org_memory_record_failure(p_provider text, p_workspace text, p_source text, p_title text, p_url text, p_code text) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  perform public.org_memory_guard();
  if p_code is null or p_code not in ('not_connected', 'permission_denied', 'rate_limited', 'timeout', 'error') then raise exception 'unknown failure code' using errcode = '22023'; end if;
  insert into public.org_source_docs (provider, workspace_id, source_id, url, title, sync_status, attempts, last_error)
    values (p_provider, p_workspace, p_source, p_url, left(coalesce(p_title, ''), 200), 'failed', 1, p_code)
  on conflict (provider, workspace_id, source_id) do update
    set sync_status = 'failed', attempts = public.org_source_docs.attempts + 1, last_error = p_code;
end $$;

create function public.org_memory_archive_doc(p_provider text, p_workspace text, p_source text) returns void
  language plpgsql security definer set search_path = ''
as $$
declare did uuid;
begin
  perform public.org_memory_guard();
  update public.org_source_docs set archived = true, sync_status = 'archived' where provider = p_provider and workspace_id = p_workspace and source_id = p_source returning id into did;
  -- Records of a source that no longer exists are marked stale, never deleted: the review history is kept.
  if did is not null then update public.org_entities set stale = true where source_doc_id = did; end if;
end $$;

create function public.org_memory_mark_extracted(p_doc uuid, p_hash text, p_error text) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  perform public.org_memory_guard();
  if p_error is not null and p_error <> 'extraction_failed' then raise exception 'unknown extraction error code' using errcode = '22023'; end if;
  update public.org_source_docs set extracted_hash = case when p_error is null then p_hash else extracted_hash end, extraction_error = p_error where id = p_doc;
end $$;

-- L1 write for one extracted record. Returns 'created', 'updated', 'unchanged' or 'staled'. NEVER overwrites a reviewed record: a different
-- extraction waits as a pending revision, and a rejected record is never brought back by a re-extraction.
create function public.org_memory_upsert_entity(
  p_doc uuid, p_stable text, p_type text, p_name text, p_description text, p_evidence text[], p_basis text, p_confidence text,
  p_owner text, p_team text, p_due text, p_unknowns text[]
) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  e public.org_entities;
  same boolean;
  sorted_new text[] := (select coalesce(array_agg(x order by x), '{}') from unnest(coalesce(p_unknowns, '{}')) x);
begin
  perform public.org_memory_guard();
  select * into e from public.org_entities where source_doc_id = p_doc and stable_id = p_stable for update;
  if not found then
    insert into public.org_entities (stable_id, source_doc_id, entity_type, name, description, evidence, basis, confidence, owner, team, due, unknowns)
      values (p_stable, p_doc, p_type, p_name, p_description, p_evidence, p_basis, p_confidence, p_owner, p_team, p_due, sorted_new);
    return 'created';
  end if;
  same := e.description = p_description and e.basis = p_basis and e.confidence = p_confidence and e.evidence = p_evidence
    and e.owner is not distinct from p_owner and e.team is not distinct from p_team and e.due is not distinct from p_due
    and (select coalesce(array_agg(x order by x), '{}') from unnest(e.unknowns) x) = sorted_new;
  if e.review_status = 'rejected' then return 'unchanged'; end if;
  if e.review_status = 'proposed' then
    if same and not e.stale then return 'unchanged'; end if;
    update public.org_entities set description = p_description, evidence = p_evidence, basis = p_basis, confidence = p_confidence, owner = p_owner, team = p_team, due = p_due,
      unknowns = sorted_new, extracted_at = now(), stale = false, pending_revision = null where id = e.id;
    return 'updated';
  end if;
  if same then
    if e.stale or e.pending_revision is not null then update public.org_entities set stale = false, pending_revision = null where id = e.id; end if;
    return 'unchanged';
  end if;
  update public.org_entities set stale = true, pending_revision = jsonb_build_object(
    'description', p_description, 'evidence', to_jsonb(p_evidence), 'basis', p_basis, 'confidence', p_confidence, 'owner', p_owner, 'team', p_team, 'due', p_due,
    'unknowns', to_jsonb(sorted_new), 'extracted_at', now()) where id = e.id;
  return 'staled';
end $$;

-- After an extraction: records of that document that the new extraction no longer states are marked stale (not deleted, not rejected).
create function public.org_memory_stale_missing(p_doc uuid, p_keep text[]) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare n integer;
begin
  perform public.org_memory_guard();
  update public.org_entities set stale = true
    where source_doc_id = p_doc and review_status <> 'rejected' and not stale and not (stable_id = any (coalesce(p_keep, '{}')));
  get diagnostics n = row_count;
  return n;
end $$;

-- The only way to change a review status. Administrators only; locks the row, validates the transition, writes the history in one transaction.
create function public.org_memory_review(p_id uuid, p_action text, p_note text) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  e public.org_entities;
  note text := nullif(btrim(p_note), '');
  r jsonb;
begin
  perform public.org_memory_guard();
  if p_action is null or p_action not in ('approve', 'reject', 'accept_revision', 'dismiss_revision') then raise exception 'unknown review action' using errcode = '22023'; end if;
  if note is not null and char_length(note) > 500 then raise exception 'note too long' using errcode = '22001'; end if;
  select * into e from public.org_entities where id = p_id for update;
  if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
  if p_action = 'approve' then
    if e.review_status <> 'proposed' then raise exception 'only a proposed record can be approved' using errcode = '55000'; end if;
    update public.org_entities set review_status = 'reviewed' where id = e.id;
  elsif p_action = 'reject' then
    if e.review_status = 'rejected' then raise exception 'already rejected' using errcode = '55000'; end if;
    update public.org_entities set review_status = 'rejected', pending_revision = null where id = e.id;
  else
    if e.pending_revision is null then raise exception 'no revision is waiting' using errcode = '55000'; end if;
    if p_action = 'accept_revision' then
      r := e.pending_revision;
      update public.org_entities set description = r ->> 'description', evidence = (select array_agg(x) from jsonb_array_elements_text(r -> 'evidence') x), basis = r ->> 'basis',
        confidence = r ->> 'confidence', owner = r ->> 'owner', team = r ->> 'team', due = r ->> 'due',
        unknowns = (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(r -> 'unknowns') x), extracted_at = (r ->> 'extracted_at')::timestamptz,
        stale = false, pending_revision = null, review_status = case when e.review_status = 'promotion_proposed' then 'reviewed' else e.review_status end,
        knowledge_item_id = case when e.review_status = 'promotion_proposed' then null else e.knowledge_item_id end where id = e.id;
    else
      update public.org_entities set pending_revision = null where id = e.id;
    end if;
  end if;
  insert into public.org_entity_events (entity_id, actor_id, action, note) values (e.id, auth.uid(), p_action, note);
end $$;

-- A reviewed record that was proposed to the Knowledge Base (through the existing submit path; approval stays with public.knowledge_review()).
create function public.org_memory_mark_promotion(p_id uuid, p_knowledge uuid) returns void
  language plpgsql security definer set search_path = ''
as $$
declare e public.org_entities;
begin
  perform public.org_memory_guard();
  select * into e from public.org_entities where id = p_id for update;
  if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
  if e.review_status <> 'reviewed' or e.stale then raise exception 'only a current, reviewed record can be proposed to the Knowledge Base' using errcode = '55000'; end if;
  if not exists (select 1 from public.knowledge_items k where k.id = p_knowledge and k.status = 'proposed') then raise exception 'no such proposed knowledge item' using errcode = '55000'; end if;
  update public.org_entities set review_status = 'promotion_proposed', knowledge_item_id = p_knowledge where id = e.id;
  insert into public.org_entity_events (entity_id, actor_id, action) values (e.id, auth.uid(), 'promotion_proposed');
end $$;

-- Takes the single ingestion slot or refuses (55P03). Expired runs (older than 15 minutes, never finished) are closed as 'failed' first.
create function public.org_memory_run_start() returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare rid uuid;
begin
  perform public.org_memory_guard();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org_ingest_runs', 0));
  update public.org_ingest_runs set status = 'failed', finished_at = now(), report = jsonb_build_object('abandoned', true)
    where finished_at is null and started_at < now() - interval '15 minutes';
  if exists (select 1 from public.org_ingest_runs where finished_at is null) then raise exception 'an ingestion run is already in progress' using errcode = '55P03'; end if;
  insert into public.org_ingest_runs (started_by) values (auth.uid()) returning id into rid;
  return rid;
end $$;

create function public.org_memory_run_finish(p_run uuid, p_status text, p_report jsonb) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  perform public.org_memory_guard();
  if p_status is null or p_status not in ('ok', 'partial', 'failed') then raise exception 'unknown run status' using errcode = '22023'; end if;
  if p_report is not null and (jsonb_typeof(p_report) <> 'object' or pg_catalog.octet_length(p_report::text) > 4000) then raise exception 'report too large' using errcode = '22001'; end if;
  update public.org_ingest_runs set status = p_status, finished_at = now(), report = p_report where id = p_run and finished_at is null;
  if not found then raise exception 'run not found or already finished' using errcode = 'P0002'; end if;
end $$;

revoke all on function public.org_memory_run_start(), public.org_memory_run_finish(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.org_memory_run_start(), public.org_memory_run_finish(uuid, text, jsonb) to authenticated;

revoke all on function public.org_memory_guard(),public.org_memory_upsert_doc(text, text, text, text, text, text, text, jsonb, jsonb, text, timestamptz, text),
  public.org_memory_record_failure(text, text, text, text, text, text), public.org_memory_archive_doc(text, text, text), public.org_memory_mark_extracted(uuid, text, text),
  public.org_memory_upsert_entity(uuid, text, text, text, text, text[], text, text, text, text, text, text[]), public.org_memory_stale_missing(uuid, text[]),
  public.org_memory_review(uuid, text, text), public.org_memory_mark_promotion(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_memory_upsert_doc(text, text, text, text, text, text, text, jsonb, jsonb, text, timestamptz, text),
  public.org_memory_record_failure(text, text, text, text, text, text), public.org_memory_archive_doc(text, text, text), public.org_memory_mark_extracted(uuid, text, text),
  public.org_memory_upsert_entity(uuid, text, text, text, text, text[], text, text, text, text, text, text[]), public.org_memory_stale_missing(uuid, text[]),
  public.org_memory_review(uuid, text, text), public.org_memory_mark_promotion(uuid, uuid) to authenticated;
-- org_memory_guard stays internal: only the definer functions above call it.

-- ------------------------------------------------------------------ row level security
alter table public.org_source_docs enable row level security;
alter table public.org_entities enable row level security;
alter table public.org_entity_events enable row level security;
alter table public.org_ingest_runs enable row level security;
create policy org_source_docs_read on public.org_source_docs for select to authenticated using (public.is_admin());
create policy org_entities_read on public.org_entities for select to authenticated using (public.is_admin());
create policy org_entity_events_read on public.org_entity_events for select to authenticated using (public.is_admin());
create policy org_ingest_runs_read on public.org_ingest_runs for select to authenticated using (public.is_admin());

-- ------------------------------------------------------------------ privileges
-- Revoke everything, then grant back SELECT to authenticated (row level security narrows it to administrators). Nobody gets INSERT, UPDATE,
-- DELETE or TRUNCATE; nothing goes to anon or service_role. Every write goes through a function above.
revoke all on public.org_source_docs, public.org_entities, public.org_entity_events, public.org_ingest_runs from public, anon, authenticated, service_role;
grant select on public.org_source_docs, public.org_entities, public.org_entity_events, public.org_ingest_runs to authenticated;

-- ROLLBACK (manual; destroys the stored sources, extracted records and review history):
--   drop table public.org_ingest_runs, public.org_entity_events, public.org_entities, public.org_source_docs;
--   drop function public.org_memory_run_finish(uuid, text, jsonb), public.org_memory_run_start(), public.org_memory_mark_promotion(uuid, uuid), public.org_memory_review(uuid, text, text), public.org_memory_stale_missing(uuid, text[]),
--     public.org_memory_upsert_entity(uuid, text, text, text, text, text[], text, text, text, text, text, text[]), public.org_memory_mark_extracted(uuid, text, text),
--     public.org_memory_archive_doc(text, text, text), public.org_memory_record_failure(text, text, text, text, text, text),
--     public.org_memory_upsert_doc(text, text, text, text, text, text, text, jsonb, jsonb, text, timestamptz, text), public.org_memory_guard();

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
