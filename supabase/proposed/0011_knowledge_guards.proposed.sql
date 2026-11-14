-- ============================================================================================
-- DRAFT, NOT APPLIED to any database (written 2026-10-31). Do not run without the owner's explicit approval, and only on broko-dev first.
-- Knowledge guards, two fixes found in the review of 0009:
--   1. A replacement must match the item it replaces in scope, project AND topic. Before this, a proposal could name ANY approved item it
--      could see (another scope, another project, another subject) and approving it would silently retire that item. Topic is compared
--      null-safely: two items without a topic match each other, an item with a topic only matches the same topic. (Phase 2 refinement,
--      2026-11-02; the file is still an unapplied draft, so it was edited in place. Whether a stricter or looser topic rule is wanted is an
--      open owner decision.)
--   2. An administrator-only way to REMOVE the content of a knowledge item that should never have been stored (a secret, personal data,
--      a wrong statement). 0009 gives nobody UPDATE or DELETE, so before this the only way was owner SQL.
-- Depends on 0009 (public.knowledge_items, knowledge_events, knowledge_review, knowledge_replaceable) and 0001 (public.is_admin()).
-- It does NOT edit 0009 or 0010, which are applied to broko-dev exactly as reviewed; everything here is a new object or an in-place
-- replacement done by this file. Verified ONLY on a local PostgreSQL (supabase/proposed/tests/0011_knowledge_guards.pglite.mjs).
--
-- WHAT CHANGES
--   * knowledge_items.redacted_at (new, nullable, not client-writable): set when the content was removed.
--   * knowledge_events.action also accepts 'redacted'.
--   * knowledge_can_replace(id, scope, project_id, topic) (new): the approved item the caller can see AND that has the same scope, project
--     and topic. The insert policy now uses it instead of knowledge_replaceable(uuid), which stays in place, unused by the policy, and
--     untouched.
--   * knowledge_review(): same behaviour as 0009, plus: approving a replacement whose target has a different scope, project or topic is
--     refused (SQLSTATE 23514) and changes nothing. This also protects a row that somehow got past the insert policy.
--   * knowledge_redact(id, reason) (new): administrators only. Replaces title and body with fixed text, clears topic, source_ref and the
--     review note, clears every history note of that item, stops the item being used (proposed becomes rejected, approved becomes
--     expired), and writes one 'redacted' history row. The reason is a FIXED list (secret, personal_data, incorrect, other), never free
--     text, so the removal record cannot itself carry the removed content.
--
-- WHAT DOES NOT CHANGE: no privilege is granted to anon, service_role or (on any table) authenticated beyond what 0009 granted; nobody
-- gets UPDATE, DELETE or TRUNCATE; the row stays (history and foreign keys intact), only its text is gone.
-- LIMITS, stated honestly: redaction cannot reach a copy that is already outside the database (database backups, logs, an exported
-- file, or an answer that quoted the item earlier; the chat audit never stores answers). The database cannot detect secrets by itself;
-- detection stays in the application, and this function is the clean-up when it misses one.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
select set_config('broko.prev_role', current_user, false);
set role postgres;

-- ------------------------------------------------------------------ marker for removed content
alter table public.knowledge_items add column if not exists redacted_at timestamptz;

-- ------------------------------------------------------------------ history vocabulary gains 'redacted'
-- The check is found by the column it covers (its name was generated) and re-added under a stable name, as 0010 does.
do $$
declare
  c text;
  action_col smallint;
begin
  select attnum into action_col from pg_attribute where attrelid = 'public.knowledge_events'::regclass and attname = 'action' and not attisdropped;
  if action_col is null then raise exception '0011 needs public.knowledge_events from 0009'; end if;
  for c in select conname from pg_constraint where conrelid = 'public.knowledge_events'::regclass and contype = 'c' and conkey = array[action_col] loop
    execute format('alter table public.knowledge_events drop constraint %I', c);
  end loop;
end $$;
alter table public.knowledge_events add constraint knowledge_events_action_check
  check (action in ('submitted', 'approved', 'rejected', 'expired', 'superseded', 'redacted'));

-- ------------------------------------------------------------------ replacement must match in scope, project and topic
-- Same visibility rule as knowledge_replaceable(uuid) in 0009, plus: same scope, the same project (both null for the whole organization)
-- and the same topic (both null when neither has one). Returns a boolean only, never a row. A function because a policy cannot query its own table.
create or replace function public.knowledge_can_replace(p_id uuid, p_scope text, p_project_id uuid, p_topic text) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.knowledge_items k
    where k.id = p_id and k.status = 'approved'
      and k.scope = p_scope and k.project_id is not distinct from p_project_id and k.topic is not distinct from p_topic
      and (k.scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = k.project_id and (p.archived_at is null or public.is_admin())))
  )
$$;
revoke all on function public.knowledge_can_replace(uuid, text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.knowledge_can_replace(uuid, text, uuid, text) to authenticated;

-- Only the supersedes clause changes; every other condition is the 0009 policy, word for word. Roles stay authenticated-only.
alter policy knowledge_items_insert on public.knowledge_items
  with check (
    author_id = auth.uid()
    and status = 'proposed' and reviewed_by is null and reviewed_at is null and review_note is null
    and (scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = project_id))
    and (supersedes_id is null or public.knowledge_can_replace(supersedes_id, scope, project_id, topic))
  );

-- ------------------------------------------------------------------ review: refuse a mismatched replacement at approval time
-- Identical to the 0009 function except for the marked check. CREATE OR REPLACE keeps the owner and the privileges; they are restated
-- below so the file reads the same whether or not it is run twice.
create or replace function public.knowledge_review(p_id uuid, p_action text, p_note text) returns void
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
        -- 0011: a replacement may only retire an item of the same scope, project and topic. Nothing has been changed yet when this raises.
        if prior.scope <> k.scope or prior.project_id is distinct from k.project_id or prior.topic is distinct from k.topic then
          raise exception 'a replacement must have the same scope, project and topic as the item it replaces' using errcode = '23514';
        end if;
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

-- ------------------------------------------------------------------ remove the content of one item
-- Administrators only, checked against the caller's session (auth.uid()), never against anything the caller supplies. Locks the row,
-- blanks the text, stops the item being used, clears the history notes of that item and records the removal, in one transaction.
-- A proposed item becomes 'rejected' (and shows who removed it); an approved item becomes 'expired' (the original approver stays);
-- a rejected, expired or superseded item keeps its status. The fixed placeholder text satisfies the length checks of 0009.
create or replace function public.knowledge_redact(p_id uuid, p_reason text) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  k public.knowledge_items;
  new_status text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'only administrators can remove knowledge content' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('secret', 'personal_data', 'incorrect', 'other') then raise exception 'unknown removal reason' using errcode = '22023'; end if;

  select * into k from public.knowledge_items where id = p_id for update;
  if not found then raise exception 'knowledge item not found' using errcode = 'P0002'; end if;
  if k.redacted_at is not null then raise exception 'the content was already removed' using errcode = '55000'; end if;

  new_status := case k.status when 'proposed' then 'rejected' when 'approved' then 'expired' else k.status end;

  update public.knowledge_items set
    title = '[Removed]',
    body = 'The content of this item was removed by an administrator.',
    topic = null,
    source_ref = null,
    review_note = null,
    status = new_status,
    redacted_at = now(),
    reviewed_by = case when k.status = 'proposed' then auth.uid() else reviewed_by end,
    reviewed_at = case when k.status = 'proposed' then now() else reviewed_at end
  where id = k.id;

  -- Earlier history notes were written by reviewers and could repeat the removed text.
  update public.knowledge_events set note = null where item_id = k.id and note is not null;
  insert into public.knowledge_events (item_id, actor_id, action, from_status, to_status, note)
    values (k.id, auth.uid(), 'redacted', k.status, new_status, 'Content removed (' || replace(p_reason, '_', ' ') || ')');
end $$;
revoke all on function public.knowledge_redact(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.knowledge_redact(uuid, text) to authenticated;

-- ROLLBACK (manual; each step is independent):
--   * restore the 0009 policy: alter policy knowledge_items_insert on public.knowledge_items with check (... knowledge_replaceable(supersedes_id) ...), then drop function public.knowledge_can_replace(uuid, text, uuid, text);
--   * restore the 0009 body of knowledge_review (create or replace with the text in 0009_knowledge.proposed.sql);
--   * drop function public.knowledge_redact(uuid, text); content that was already removed is NOT recoverable;
--   * the 'redacted' history vocabulary and the redacted_at column can stay; removing them is refused while any row uses them.

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
