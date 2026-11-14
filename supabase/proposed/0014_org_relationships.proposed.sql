-- ============================================================================================
-- PROPOSED, NOT APPLIED. Organizational relationships (Phase 2B), on top of persistent organizational memory (0013):
--   org_relationships        a typed, evidence-backed link between two EXISTING L1 entities of the same stored document (PROPOSED intelligence)
--   org_relationship_events  append-only review history
-- A relationship says "this task is ASSIGNED_TO that person" and cites the source segments that support it. Nothing here approves anything
-- outside this table: promotion to the Knowledge Base stays with the existing workflow, and no graph database is introduced (ordinary rows and foreign keys).
-- Depends on 0001 (public.profiles, public.is_admin(), public.touch_updated_at()) and 0013 (public.org_source_docs, public.org_entities, public.org_memory_guard()).
-- Additive only: no drops, no data changes, no change to any 0013 object. Verified ONLY on a local PostgreSQL (supabase/proposed/tests/0014_org_relationships.pglite.mjs).
-- NOT run on any remote project, and nothing here has been verified against Supabase, PostgREST or a real session.
--
-- RULES THE DATABASE ENFORCES (the application validates the same things first; this is the second line of defence)
--   * both endpoints exist, are different, belong to the SAME stored document the evidence cites, and are eligible: not rejected, the document not archived,
--     and not stale-without-a-waiting-revision (a record the source no longer states). Otherwise the write is skipped ('skipped'), never stored.
--   * every cited segment id resolves to a segment of that document, and none of them is a flagged (instruction-like) segment.
--   * the relation type comes from a fixed vocabulary; basis is explicit | extracted | inferred; an inference is never high confidence.
--   * a REVIEWED relationship is never overwritten: a different extraction parks as a pending revision and marks it stale. A rejected one never comes back.
--   * approving an INFERRED relationship requires a written reason (an inference is never silently treated as verified).
-- WHO CAN DO WHAT: administrators only, exactly like 0013: read through row level security; write only through the functions below, which check
--   public.is_admin() against the caller's session. No API role holds INSERT, UPDATE or DELETE; service_role holds nothing.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
select set_config('broko.prev_role', current_user, false);
set role postgres;

-- ------------------------------------------------------------------ relationships
create table public.org_relationships (
  id uuid primary key default gen_random_uuid(),
  stable_id text not null check (char_length(stable_id) between 8 and 64),
  -- restrict: sources and entities are archived or rejected, never deleted, so a relationship cannot be orphaned by accident
  source_doc_id uuid not null references public.org_source_docs (id) on delete restrict,
  from_entity_id uuid not null references public.org_entities (id) on delete restrict,
  to_entity_id uuid not null references public.org_entities (id) on delete restrict,
  relation_type text not null check (relation_type in ('OWNS', 'BELONGS_TO', 'PART_OF', 'RESULTED_IN', 'DISCUSSED_IN', 'BLOCKS', 'DEPENDS_ON', 'COMMITTED_TO', 'HAS_DEADLINE', 'ASSIGNED_TO', 'RELATES_TO', 'RAISED_IN')),
  evidence text[] not null check (cardinality(evidence) between 1 and 8),   -- segment ids ("S4") of source_doc_id
  basis text not null check (basis in ('explicit', 'extracted', 'inferred')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  extracted_at timestamptz not null default now(),
  review_status text not null default 'proposed' check (review_status in ('proposed', 'reviewed', 'rejected')),
  stale boolean not null default false,
  pending_revision jsonb check (pending_revision is null or jsonb_typeof(pending_revision) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (from_entity_id, to_entity_id, relation_type),
  constraint org_relationships_not_self check (from_entity_id <> to_entity_id),
  constraint org_relationships_inferred_not_high check (basis <> 'inferred' or confidence <> 'high')
);
create index org_relationships_from_idx on public.org_relationships (from_entity_id);
create index org_relationships_to_idx on public.org_relationships (to_entity_id);
create index org_relationships_doc_idx on public.org_relationships (source_doc_id);
create index org_relationships_type_idx on public.org_relationships (relation_type, extracted_at desc);
create index org_relationships_queue_idx on public.org_relationships (review_status, extracted_at) where review_status = 'proposed' or stale;
create trigger org_relationships_touch before update on public.org_relationships for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ review history (append only; written by functions only)
create table public.org_relationship_events (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.org_relationships (id) on delete restrict,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in ('approve', 'reject', 'accept_revision', 'dismiss_revision')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index org_relationship_events_rel_idx on public.org_relationship_events (relationship_id, created_at);

-- ------------------------------------------------------------------ functions (SECURITY DEFINER, empty search_path, administrators only)
-- Internal helper: is this entity a valid endpoint? Not rejected, its document not archived, and not a record the source no longer states.
create function public.org_relationship_endpoint_ok(p_entity uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_entities e join public.org_source_docs d on d.id = e.source_doc_id
    where e.id = p_entity and e.review_status <> 'rejected' and not d.archived and not (e.stale and e.pending_revision is null)
  );
$$;

-- Returns 'created', 'updated', 'unchanged', 'staled' or 'skipped' (an endpoint is missing or not eligible, or the endpoints are the same entity).
create function public.org_relationship_upsert(
  p_doc uuid, p_stable text, p_from uuid, p_to uuid, p_type text, p_evidence text[], p_basis text, p_confidence text
) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  r public.org_relationships;
  f public.org_entities;
  t public.org_entities;
  d public.org_source_docs;
  same boolean;
  ids text[] := (select coalesce(array_agg(distinct x order by x), '{}') from unnest(coalesce(p_evidence, '{}')) x);
begin
  perform public.org_memory_guard();
  if p_from is not distinct from p_to then return 'skipped'; end if;
  select * into f from public.org_entities where id = p_from;
  select * into t from public.org_entities where id = p_to;
  if f.id is null or t.id is null then return 'skipped'; end if;
  if not public.org_relationship_endpoint_ok(p_from) or not public.org_relationship_endpoint_ok(p_to) then return 'skipped'; end if;
  if f.source_doc_id <> p_doc or t.source_doc_id <> p_doc then raise exception 'both endpoints must belong to the cited document' using errcode = '22023'; end if;
  select * into d from public.org_source_docs where id = p_doc;
  if d.id is null or d.archived then return 'skipped'; end if;
  -- every cited segment must exist in the document and must not be a flagged segment
  if cardinality(ids) = 0 or (select count(*) from jsonb_array_elements(d.segments) s where s ->> 'id' = any (ids) and coalesce((s ->> 'flagged')::boolean, false) = false) <> cardinality(ids) then
    raise exception 'evidence does not resolve to segments of the document' using errcode = '22023';
  end if;

  select * into r from public.org_relationships where from_entity_id = p_from and to_entity_id = p_to and relation_type = p_type for update;
  if not found then
    insert into public.org_relationships (stable_id, source_doc_id, from_entity_id, to_entity_id, relation_type, evidence, basis, confidence)
      values (p_stable, p_doc, p_from, p_to, p_type, p_evidence, p_basis, p_confidence);
    return 'created';
  end if;
  same := r.evidence = p_evidence and r.basis = p_basis and r.confidence = p_confidence and r.source_doc_id = p_doc;
  if r.review_status = 'rejected' then return 'unchanged'; end if;
  if r.review_status = 'proposed' then
    if same and not r.stale then return 'unchanged'; end if;
    update public.org_relationships set evidence = p_evidence, basis = p_basis, confidence = p_confidence, extracted_at = now(), stale = false, pending_revision = null where id = r.id;
    return 'updated';
  end if;
  -- reviewed: never overwritten
  if same then
    if r.stale or r.pending_revision is not null then update public.org_relationships set stale = false, pending_revision = null where id = r.id; end if;
    return 'unchanged';
  end if;
  update public.org_relationships set stale = true, pending_revision = jsonb_build_object(
    'evidence', to_jsonb(p_evidence), 'basis', p_basis, 'confidence', p_confidence, 'extracted_at', now()) where id = r.id;
  return 'staled';
end $$;

-- After an extraction: relationships of that document that the new extraction no longer states are marked stale (not deleted, not rejected).
create function public.org_relationship_stale_missing(p_doc uuid, p_keep text[]) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare n integer;
begin
  perform public.org_memory_guard();
  if p_keep is null or cardinality(p_keep) = 0 then return 0; end if; -- an extraction that kept nothing proves nothing about what the document states
  update public.org_relationships set stale = true
    where source_doc_id = p_doc and review_status <> 'rejected' and not stale and not (stable_id = any (coalesce(p_keep, '{}')));
  get diagnostics n = row_count;
  return n;
end $$;

-- The only way to change a relationship's review status. Administrators only; locks the row, validates the transition, writes the history in one transaction.
create function public.org_relationship_review(p_id uuid, p_action text, p_note text) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  r public.org_relationships;
  note text := nullif(btrim(p_note), '');
  x jsonb;
begin
  perform public.org_memory_guard();
  if p_action is null or p_action not in ('approve', 'reject', 'accept_revision', 'dismiss_revision') then raise exception 'unknown review action' using errcode = '22023'; end if;
  if note is not null and char_length(note) > 500 then raise exception 'note too long' using errcode = '22001'; end if;
  select * into r from public.org_relationships where id = p_id for update;
  if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
  if p_action = 'approve' then
    if r.review_status <> 'proposed' then raise exception 'only a proposed relationship can be approved' using errcode = '55000'; end if;
    if r.stale then raise exception 'a stale relationship cannot be approved while its source has changed' using errcode = '55000'; end if;
    if not public.org_relationship_endpoint_ok(r.from_entity_id) or not public.org_relationship_endpoint_ok(r.to_entity_id) then raise exception 'an endpoint is no longer eligible' using errcode = '55000'; end if;
    if r.basis = 'inferred' and note is null then raise exception 'approving an inferred relationship needs a written reason' using errcode = '22023'; end if;
    update public.org_relationships set review_status = 'reviewed' where id = r.id;
  elsif p_action = 'reject' then
    if r.review_status = 'rejected' then raise exception 'already rejected' using errcode = '55000'; end if;
    update public.org_relationships set review_status = 'rejected', pending_revision = null where id = r.id;
  else
    if r.pending_revision is null then raise exception 'no revision is waiting' using errcode = '55000'; end if;
    if p_action = 'accept_revision' then
      if not public.org_relationship_endpoint_ok(r.from_entity_id) or not public.org_relationship_endpoint_ok(r.to_entity_id) then raise exception 'an endpoint is no longer eligible' using errcode = '55000'; end if;
      x := r.pending_revision;
      if (x ->> 'basis') = 'inferred' and note is null then raise exception 'accepting an inferred revision needs a written reason' using errcode = '22023'; end if;
      update public.org_relationships set evidence = (select array_agg(e) from jsonb_array_elements_text(x -> 'evidence') e), basis = x ->> 'basis', confidence = x ->> 'confidence',
        extracted_at = (x ->> 'extracted_at')::timestamptz, stale = false, pending_revision = null where id = r.id;
    else
      update public.org_relationships set pending_revision = null where id = r.id;
    end if;
  end if;
  insert into public.org_relationship_events (relationship_id, actor_id, action, note) values (r.id, auth.uid(), p_action, note);
end $$;

revoke all on function public.org_relationship_endpoint_ok(uuid), public.org_relationship_upsert(uuid, text, uuid, uuid, text, text[], text, text),
  public.org_relationship_stale_missing(uuid, text[]), public.org_relationship_review(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.org_relationship_upsert(uuid, text, uuid, uuid, text, text[], text, text), public.org_relationship_stale_missing(uuid, text[]),
  public.org_relationship_review(uuid, text, text) to authenticated;
-- org_relationship_endpoint_ok stays internal: only the definer functions above call it (like org_memory_guard).

-- ------------------------------------------------------------------ row level security
alter table public.org_relationships enable row level security;
alter table public.org_relationship_events enable row level security;
create policy org_relationships_read on public.org_relationships for select to authenticated using (public.is_admin());
create policy org_relationship_events_read on public.org_relationship_events for select to authenticated using (public.is_admin());

-- ------------------------------------------------------------------ privileges
-- Revoke everything, then grant back SELECT to authenticated (row level security narrows it to administrators). Nobody gets INSERT, UPDATE,
-- DELETE or TRUNCATE; nothing goes to anon or service_role. Every write goes through a function above.
revoke all on public.org_relationships, public.org_relationship_events from public, anon, authenticated, service_role;
grant select on public.org_relationships, public.org_relationship_events to authenticated;

-- ROLLBACK (manual; destroys the stored relationships and their review history; leaves 0013 untouched):
--   drop table public.org_relationship_events, public.org_relationships;
--   drop function public.org_relationship_review(uuid, text, text), public.org_relationship_stale_missing(uuid, text[]),
--     public.org_relationship_upsert(uuid, text, uuid, uuid, text, text[], text, text), public.org_relationship_endpoint_ok(uuid);

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
