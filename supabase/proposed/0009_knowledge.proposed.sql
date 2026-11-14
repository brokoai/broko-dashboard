-- ============================================================================================
-- PROPOSED, NOT APPLIED. Central AI Brain: governed organizational knowledge (decisions, corrections, procedures, project notes),
-- a change history, and metadata-only answer feedback.
-- Depends on 0001 (public.profiles, public.is_admin(), public.touch_updated_at()) and 0007 (public.precon_projects, whose row level
-- security decides which projects a person may see). Independent of 0008 (the chat audit); 0010 widens the chat audit vocabulary.
-- Additive only: no drops, no data changes. Verified ONLY on a local PostgreSQL (supabase/proposed/tests/0009_knowledge.pglite.mjs).
-- NOT run on any remote project, and nothing here has been verified against Supabase, PostgREST or a real session.
--
-- WHAT THIS IS: text that a person deliberately wrote down and an administrator approved. It is NOT copied from chat, it is NOT
--   model training, and it is NOT the chat audit (that stays metadata-only). The assistant only RETRIEVES approved, current items.
--
-- WHO CAN DO WHAT:
--   submit   : any signed-in user, only as themself, only as a PROPOSAL (status is not a writable column and defaults to
--              'proposed'). Project knowledge needs a project the submitter can see (precon_projects row level security).
--   read     : administrators read everything. An author reads their own submissions in every status. Everyone else reads only
--              APPROVED items that are in effect and not past their expiry, and project items only for projects they can see.
--              A proposed, rejected, superseded or expired item of someone else is invisible to them.
--   review   : administrators only, and only through public.knowledge_review(): approve or reject a proposed item, or expire an
--              approved one. Approving a replacement supersedes the item it replaces, in the same transaction. Every change is
--              written to knowledge_events by the function. Nobody (administrators included) can UPDATE or DELETE rows through the
--              API; there is no privilege for it.
--   history  : knowledge_events is readable by administrators only, and nobody can write it directly.
--   feedback : any signed-in user may record "useful / not useful" about an answer, as themself. Metadata only (fixed vocabularies,
--              no free text, no question, no answer). Only administrators read it.
-- Members cannot approve their own submissions: they have no UPDATE privilege and public.knowledge_review() refuses non-administrators.
--
-- TENANCY (designed for, NOT implemented): organization_id is reserved, nullable and not client-writable, like chat_audit.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
select set_config('broko.prev_role', current_user, false);
set role postgres;

-- ------------------------------------------------------------------ knowledge items
create table public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,                                    -- reserved for future tenant isolation; always NULL today
  kind text not null check (kind in ('decision', 'correction', 'procedure', 'project_note')),
  scope text not null check (scope in ('organization', 'project')),
  -- restrict: projects are archived, not deleted; a project that still has knowledge cannot be removed by accident.
  project_id uuid references public.precon_projects (id) on delete restrict,
  title text not null check (char_length(title) between 3 and 160),
  body text not null check (char_length(body) between 10 and 2000),
  topic text check (char_length(topic) <= 60 and topic ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'superseded', 'expired')),
  author_id uuid references public.profiles (id) on delete set null,
  source_type text not null default 'manual' check (source_type in ('manual', 'correction')),
  source_ref text check (char_length(source_ref) <= 200),  -- where the author says it comes from; free text written by a person
  supersedes_id uuid references public.knowledge_items (id) on delete set null,
  effective_from timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 500),
  constraint knowledge_scope_matches_project check ((scope = 'organization' and project_id is null) or (scope = 'project' and project_id is not null)),
  constraint knowledge_project_note_needs_project check (kind <> 'project_note' or scope = 'project'),
  constraint knowledge_source_matches_kind check ((kind = 'correction') = (source_type = 'correction')),
  constraint knowledge_expiry_after_start check (expires_at is null or expires_at > effective_from),
  constraint knowledge_proposed_is_unreviewed check (status <> 'proposed' or (reviewed_by is null and reviewed_at is null))
);
create index knowledge_items_status_idx on public.knowledge_items (status, created_at);
create index knowledge_items_author_idx on public.knowledge_items (author_id, created_at desc);
create index knowledge_items_project_idx on public.knowledge_items (project_id) where project_id is not null;
create index knowledge_items_topic_idx on public.knowledge_items (topic) where topic is not null;
create trigger knowledge_items_touch before update on public.knowledge_items for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ change history (append only; written by functions only)
create table public.knowledge_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.knowledge_items (id) on delete restrict,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in ('submitted', 'approved', 'rejected', 'expired', 'superseded')),
  from_status text check (from_status in ('proposed', 'approved', 'rejected', 'superseded', 'expired')),
  to_status text not null check (to_status in ('proposed', 'approved', 'rejected', 'superseded', 'expired')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index knowledge_events_item_idx on public.knowledge_events (item_id, created_at);

-- ------------------------------------------------------------------ answer feedback (metadata only)
create table public.answer_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  actor_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  rating text not null check (rating in ('useful', 'not_useful')),
  reason text check (reason in ('wrong', 'outdated', 'missing', 'unclear', 'other')),
  -- The same fixed vocabularies as the chat audit (0010), so a rating can be tied to the kind of answer without storing any text.
  intent text check (intent in ('attention', 'pending_tasks', 'today', 'overdue', 'upcoming', 'priority', 'owners', 'notifications', 'ai_inbox',
                                'integrations', 'sources', 'summary', 'preconstruction', 'knowledge', 'action_request', 'blocked', 'clarify', 'unsupported', 'help')),
  source_ids text[] not null default '{}'
    check (cardinality(source_ids) <= 13
           and source_ids <@ array['tasks', 'activity', 'notifications', 'ai_inbox', 'integrations', 'email', 'teams', 'whatsapp', 'calendar', 'crm', 'documents', 'preconstruction', 'knowledge'])
);
create index answer_feedback_actor_idx on public.answer_feedback (actor_id, created_at desc);

-- ------------------------------------------------------------------ triggers (all SECURITY DEFINER, empty search_path, no API role may execute them)
-- Burst caps: a safety net against direct API abuse (the app's own limits are far lower). Same design as 0008: the function counts the
-- caller's recent rows as its owner, takes a per-user transaction advisory lock so simultaneous requests cannot both pass, and is
-- applied only to rows the caller writes as themself (a forged author is refused by row level security anyway).
create function public.knowledge_items_burst_cap() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if new.author_id is null or new.author_id is distinct from auth.uid() then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('knowledge_items:' || new.author_id::text, 0));
  if (select count(*) from public.knowledge_items k where k.author_id = new.author_id and k.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'knowledge submission rate limit' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger knowledge_items_burst_cap before insert on public.knowledge_items for each row execute function public.knowledge_items_burst_cap();

create function public.answer_feedback_burst_cap() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if new.actor_id is null or new.actor_id is distinct from auth.uid() then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('answer_feedback:' || new.actor_id::text, 0));
  if (select count(*) from public.answer_feedback f where f.actor_id = new.actor_id and f.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'feedback rate limit' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger answer_feedback_burst_cap before insert on public.answer_feedback for each row execute function public.answer_feedback_burst_cap();

-- Every submission writes its first history row.
create function public.knowledge_log_submitted() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.knowledge_events (item_id, actor_id, action, from_status, to_status) values (new.id, new.author_id, 'submitted', null, new.status);
  return new;
end $$;
create trigger knowledge_log_submitted after insert on public.knowledge_items for each row execute function public.knowledge_log_submitted();

revoke all on function public.knowledge_items_burst_cap(), public.answer_feedback_burst_cap(), public.knowledge_log_submitted() from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ the only way to change a status
-- approve / reject (a PROPOSED item) or expire (an APPROVED item). Administrators only, checked inside the function against the
-- caller's session (auth.uid()), never against anything the caller supplies. Locks the row, validates the transition, changes the
-- status and writes the history in one transaction. Approving an item that replaces another approved item supersedes that one too.
create function public.knowledge_review(p_id uuid, p_action text, p_note text) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  k public.knowledge_items;
  prior public.knowledge_items;
  note text := nullif(btrim(p_note), '');
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'only administrators can review knowledge' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('approve', 'reject', 'expire') then raise exception 'unknown review action' using errcode = '22023'; end if;
  if note is not null and char_length(note) > 500 then raise exception 'note too long' using errcode = '22001'; end if;

  select * into k from public.knowledge_items where id = p_id for update;
  if not found then raise exception 'knowledge item not found' using errcode = 'P0002'; end if;

  if p_action in ('approve', 'reject') then
    if k.status <> 'proposed' then raise exception 'only proposed items can be reviewed' using errcode = '55000'; end if;
    if p_action = 'reject' and note is null then raise exception 'a reason is required to reject' using errcode = '22023'; end if;
    if p_action = 'approve' and k.expires_at is not null and k.expires_at <= now() then raise exception 'the item has already expired' using errcode = '55000'; end if;
  elsif k.status <> 'approved' then
    raise exception 'only approved items can be expired' using errcode = '55000';
  end if;

  if p_action = 'approve' then
    if k.supersedes_id is not null then
      select * into prior from public.knowledge_items where id = k.supersedes_id for update;
      if found and prior.status = 'approved' then
        update public.knowledge_items set status = 'superseded' where id = prior.id;
        insert into public.knowledge_events (item_id, actor_id, action, from_status, to_status, note)
          values (prior.id, auth.uid(), 'superseded', 'approved', 'superseded', 'Replaced by a newer approved item');
      end if;
    end if;
    update public.knowledge_items set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = note where id = k.id;
    insert into public.knowledge_events (item_id, actor_id, action, from_status, to_status, note) values (k.id, auth.uid(), 'approved', 'proposed', 'approved', note);
  elsif p_action = 'reject' then
    update public.knowledge_items set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = note where id = k.id;
    insert into public.knowledge_events (item_id, actor_id, action, from_status, to_status, note) values (k.id, auth.uid(), 'rejected', 'proposed', 'rejected', note);
  else
    -- The original approver and approval date stay on the item; who expired it, when and why is in the history.
    update public.knowledge_items set status = 'expired' where id = k.id;
    insert into public.knowledge_events (item_id, actor_id, action, from_status, to_status, note) values (k.id, auth.uid(), 'expired', 'approved', 'expired', note);
  end if;
end $$;
revoke all on function public.knowledge_review(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.knowledge_review(uuid, text, text) to authenticated;

-- Used by the insert policy below: is this an approved item the CALLER could read? (Mirrors knowledge_items_read for the approved case,
-- because a policy that queries its own table is rejected by PostgreSQL as infinite recursion.) Returns a boolean only, never a row.
create function public.knowledge_replaceable(p_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.knowledge_items k
    where k.id = p_id and k.status = 'approved'
      and (k.scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = k.project_id and (p.archived_at is null or public.is_admin())))
  )
$$;
revoke all on function public.knowledge_replaceable(uuid) from public, anon, authenticated, service_role;
grant execute on function public.knowledge_replaceable(uuid) to authenticated;

-- ------------------------------------------------------------------ row level security
alter table public.knowledge_items enable row level security;
alter table public.knowledge_events enable row level security;
alter table public.answer_feedback enable row level security;

create policy knowledge_items_read on public.knowledge_items for select to authenticated
  using (
    public.is_admin()
    or author_id = auth.uid()
    or (status = 'approved' and effective_from <= now() and (expires_at is null or expires_at > now())
        -- row level security on precon_projects applies to this subquery too: a project the caller cannot see is not visible here
        and (scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = project_id)))
  );
create policy knowledge_items_insert on public.knowledge_items for insert to authenticated
  with check (
    author_id = auth.uid()
    and status = 'proposed' and reviewed_by is null and reviewed_at is null and review_note is null
    and (scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = project_id))
    -- only an approved item the caller can see may be named as the one to replace (a function, because a policy cannot query its own table)
    and (supersedes_id is null or public.knowledge_replaceable(supersedes_id))
  );

-- history and feedback: administrators read; nobody writes the history directly; feedback is insert-only, as yourself
create policy knowledge_events_read on public.knowledge_events for select to authenticated using (public.is_admin());
create policy answer_feedback_read on public.answer_feedback for select to authenticated using (public.is_admin());
create policy answer_feedback_insert on public.answer_feedback for insert to authenticated with check (actor_id = auth.uid());

-- ------------------------------------------------------------------ privileges
-- Supabase auto-grants every privilege on new public tables to anon/authenticated/service_role (including TRUNCATE, which RLS does not
-- stop). Revoke everything, then grant back only what the app needs. Nothing goes to anon or service_role, and nobody gets UPDATE or
-- DELETE: status changes go through public.knowledge_review() and the rows are never deleted through the API.
revoke all on public.knowledge_items, public.knowledge_events, public.answer_feedback from public, anon, authenticated, service_role;
grant select on public.knowledge_items, public.knowledge_events, public.answer_feedback to authenticated;
grant insert (kind, scope, project_id, title, body, topic, author_id, source_type, source_ref, supersedes_id, expires_at) on public.knowledge_items to authenticated;
grant insert (actor_id, rating, reason, intent, source_ids) on public.answer_feedback to authenticated;

-- ROLLBACK (manual; destroys the knowledge, its history and the feedback):
--   drop table public.knowledge_events, public.answer_feedback, public.knowledge_items;
--   drop function public.knowledge_replaceable(uuid), public.knowledge_review(uuid, text, text), public.knowledge_log_submitted(), public.knowledge_items_burst_cap(), public.answer_feedback_burst_cap();

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
