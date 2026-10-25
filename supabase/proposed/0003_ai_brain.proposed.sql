-- ============================================================================================
-- PROPOSED, NOT APPLIED. Do not run against any database without explicit approval.
-- NOT APPROVED FOR APPLICATION (phase closure 2026-10-25): no Supabase repository or worker calls these functions yet, so the
-- schema would be speculative. Revisit only together with the AI Inbox Supabase integration.
-- Broko AI Brain: persistence for message references, proposals and human decisions.
-- Depends on 0001_init.sql and 0002_hardening.proposed.sql (is_admin(), touch_updated_at()).
-- Companion: 0004_ai_jobs.proposed.sql (background jobs).
--
-- STATUS: executed locally on PGlite only (supabase/proposed/tests/mutation_checks.pglite.mjs runs 0001-0004 and the
-- 0004_rls_and_jobs.proposed.sql script, and shows that script FAILS when each control below is removed). NOT run on real
-- Supabase/PostgREST/GoTrue, and nothing here proves behaviour between two real sessions (row locks, SKIP LOCKED). No Supabase
-- client code calls these functions yet (the dashboard's AI Inbox is demo-only), so the call contract is unproven end to end.
--
-- PRIVILEGES ARE EXPLICIT. This file never relies on Supabase's default privileges for its final state: every table and function
-- it creates is revoked from PUBLIC, anon, authenticated and service_role first, then granted back only what is needed.
--
-- Single-tenant by design (as 0001): one Broko organisation per project. If the database is ever shared, add an
-- organisation key to every table and policy FIRST.
-- ============================================================================================

-- -------------------------------------------------------------------------- ai_messages
-- One row per processed email. Mirrors ProcessedMessage in src/lib/ai-brain/schema.ts.
-- No email body is stored (data minimisation); `excerpt` stays NULL unless the organisation's policy sets
-- retain_excerpt_chars > 0. sender_email and subject ARE stored so a reviewer can recognise the message: this needs a
-- retention period and a data-protection decision before real mail (see the audit document).
-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
-- On the dev project the CLI's login role (cli_login_postgres) is a member of postgres with SET but NOT INHERIT and has no
-- CREATE on schema public, so objects can only be created after SET ROLE postgres (this also makes postgres the owner).
-- The previous role is saved and restored at the end instead of `reset role`: if the CLI had already switched to postgres, a
-- plain `reset role` would drop it back to the login role and the CLI's own migration-history insert, queued after this file,
-- would fail. Saving and restoring is correct whether or not the CLI switched first, and when run in the SQL editor.
select set_config('broko.prev_role', current_user, false);
set role postgres;

create table public.ai_messages (
  dedupe_key text primary key,            -- RFC 5322 Message-ID preferred; see dedupeKey(). Server-side only: never sent to a browser.
  review_id uuid not null unique default gen_random_uuid(),
                                          -- OPAQUE handle the browser uses (list identity, approve, reject). Reveals nothing about the
                                          -- message. AUTHORITATIVE HERE: a repository INSERTs without it (the default generates it) and
                                          -- always reads it back; it never derives one from the dedupe key (reviewIdFor() is for the
                                          -- in-memory demo only). Authorization never depends on it being secret:
                                          -- ai_approve_message / ai_reject_message check is_admin() first.
  workflow_id text not null,              -- hashed reference (sourceRef): what audit events and the UI use. Indexed, NOT unique:
                                          -- 48 bits can collide at very large volume; lengthen it before real mail.
  provider text not null check (provider in ('microsoft_graph', 'gmail', 'synthetic')),
  source_message_id text not null,
  internet_message_id text,
  mailbox_ref text not null,
  received_at timestamptz not null,
  sender_name text,
  sender_email text not null,
  subject text not null,
  excerpt text,
  status text not null check (status in (
    'RECEIVED', 'PROCESSING', 'NO_ACTION', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED',
    'TASK_CREATED', 'NOTIFICATION_SENT', 'FAILED')),
  analysis jsonb,                          -- validated MessageAnalysis only, never raw model text
  classifier jsonb,                        -- { name, mode: rules|llm, fallback_reason }: which classifier produced it
  grounding_notes text[] not null default '{}',
  risk_flags text[] not null default '{}',
  owner jsonb not null,                    -- the SUGGESTION: { user_id, rule_id, reason } from configured rules
  confirmed_owner jsonb,                   -- set ONLY at approval: { user_id, confirmed_by, confirmed_at }
  review_reasons text[] not null default '{}',
  proposed_priority text check (proposed_priority in ('low', 'medium', 'high', 'urgent')),
  proposed_due_at timestamptz,
  task_id uuid references public.tasks (id) on delete set null,
  notification jsonb not null default '{"attempted": false, "sent": false, "detail": "no notification attempted"}',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,                 -- server time of the human decision (now()), never client-supplied
  error jsonb,                             -- { stage, message } sanitised
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A decided message always has a server decision time, and an undecided one never does. (reviewed_by is not
  -- constrained because its foreign key may legitimately become null if the reviewer's profile is deleted.)
  constraint ai_messages_decision_time check (
    (status in ('REJECTED', 'TASK_CREATED', 'NOTIFICATION_SENT')) = (reviewed_at is not null)
  )
);
create index ai_messages_status_idx on public.ai_messages (status, created_at desc);
create index ai_messages_workflow_idx on public.ai_messages (workflow_id);

create trigger ai_messages_touch before update on public.ai_messages
  for each row execute function public.touch_updated_at();

alter table public.ai_messages enable row level security;
-- Administrators review; nobody writes from the browser. The worker uses the service role (auth.uid() is null),
-- which bypasses RLS. There are deliberately no insert/update/delete policies.
create policy ai_messages_select on public.ai_messages for select to authenticated
  using (public.is_admin());
-- Supabase's default privileges give anon/authenticated/service_role EVERY table privilege (incl. TRUNCATE, which RLS does not
-- stop). Remove them all, then give back exactly what is needed (this is the final state; defaults are not relied on):
--   authenticated : SELECT (still filtered by the admin-only RLS policy above). Decisions go through the functions below.
--   service_role  : SELECT, INSERT, UPDATE for the worker's message store (claim, classify, transition). NO DELETE, TRUNCATE,
--                   REFERENCES or TRIGGER: a retention purge, if ever needed, must be its own reviewed function.
revoke all on public.ai_messages from public, anon, authenticated, service_role;
grant select on public.ai_messages to authenticated;
grant select, insert, update on public.ai_messages to service_role;

-- ------------------------------------------------------------- task idempotency at the database
-- A given email can become at most one task, whatever the application does.
create unique index tasks_source_external_reference_uidx
  on public.tasks (source, external_reference) where external_reference is not null;

-- -------------------------------------------------------------- audit events: idempotent, typed
-- AI events live in the existing activity_events (existing event types, no new ones). Their metadata holds ONLY the
-- typed, content-free keys below, plus `event_key` which makes writes idempotent (a retried job never duplicates).
create unique index activity_events_event_key_uidx
  on public.activity_events ((metadata ->> 'event_key')) where metadata ? 'event_key';

-- The only way the worker records an AI audit event. Service role only. Validates the shape instead of trusting the caller.
create function public.ai_record_audit_event(
  p_event_type text, p_status text, p_description text, p_actor uuid, p_task uuid, p_metadata jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare k text; e record;
begin
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or not (p_metadata ? 'event_key') then
    raise exception 'metadata must be an object with an event_key';
  end if;
  for k in select jsonb_object_keys(p_metadata) loop
    if k not in ('workflow_id', 'classifier_mode', 'fallback_reason', 'intent', 'outcome', 'flags', 'error_category',
                 'decision', 'actor_kind', 'event_key') then
      raise exception 'unexpected metadata key';        -- never echo the key or value
    end if;
  end loop;
  -- VALUES are typed too (the same shape as ActivityMetadataSchema in src/lib/ai-brain/activity.ts): short enums and bounded
  -- identifiers only, so no free text (an error message, an email subject) can be stored through this function, whoever calls it.
  for e in select key, value from jsonb_each(p_metadata) loop
    if not coalesce(case e.key
      when 'workflow_id'     then jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ '^[0-9a-f]{12}$')
      when 'event_key'       then jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ '^[0-9a-z_:-]{1,120}$'
      when 'classifier_mode' then jsonb_typeof(e.value) = 'null' or (e.value #>> '{}') in ('rules', 'llm')
      when 'fallback_reason' then jsonb_typeof(e.value) = 'null' or (e.value #>> '{}') in ('model_output_invalid', 'model_unavailable')
      when 'intent'          then jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ '^[a-z_]{1,40}$')
      when 'outcome'         then jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ '^[A-Z_]{1,40}$')
      when 'error_category'  then jsonb_typeof(e.value) = 'null' or (e.value #>> '{}') in (
        'invalid_input', 'classification_failed', 'invalid_model_output', 'task_creation_failed', 'task_creation_denied',
        'notification_failed', 'processing_interrupted', 'internal_error')
      when 'decision'        then jsonb_typeof(e.value) = 'null' or (e.value #>> '{}') in ('approved', 'rejected')
      when 'actor_kind'      then jsonb_typeof(e.value) = 'null' or (e.value #>> '{}') in ('user', 'system')
      when 'flags'           then jsonb_typeof(e.value) = 'array' and jsonb_array_length(e.value) <= 12
                                  and not exists (select 1 from jsonb_array_elements(e.value) x
                                                   where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[a-z_]{1,40}$')
      else false end, false) then
      raise exception 'invalid metadata value';         -- never echo the key or value
    end if;
  end loop;
  if char_length(p_description) > 200 then raise exception 'description too long'; end if;
  insert into public.activity_events (event_type, description, status, actor_id, related_task_id, metadata)
  values (p_event_type, p_description, p_status, p_actor, p_task, p_metadata)
  on conflict ((metadata ->> 'event_key')) where metadata ? 'event_key' do nothing;
  return found;      -- false = already recorded (idempotent)
end $$;
revoke all on function public.ai_record_audit_event(text, text, text, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ai_record_audit_event(text, text, text, uuid, uuid, jsonb) to service_role;

-- --------------------------------------------------- approval: the only path that sets source
-- 0002's tasks_guard forces every human-inserted task to source='manual'. Approval must create a task with
-- source='email' atomically with the status change, and only for administrators.
--
-- REVIEW OF THE FIRST DRAFT (a transaction-local flag set with set_config and read by the guard): rejected. It makes
-- a security rule depend on a custom setting that any code path able to run SQL in the session can also set.
-- Replaced by a privilege-based test: the guard is SECURITY INVOKER, so `current_user` is the role actually executing
-- the INSERT. A browser session runs as 'authenticated' (or 'anon') and is forced to source='manual' exactly as in
-- 0002. Only the SECURITY DEFINER function below (owned by a privileged role, admin-checked inside) executes the
-- INSERT as a different role, so only it can set source='email'. No client-writable state is trusted.
--
-- STILL OPEN, to verify on a disposable Supabase branch before any approval:
--  1. `current_user` inside a trigger fired by a SECURITY DEFINER function is the definer (expected).
--  2. is_admin() still works from an invoker trigger (it is itself SECURITY DEFINER).
--  3. The function owner is not 'authenticated'/'anon' and cannot be assumed by clients.
--  4. Whether the privileged owner should be a dedicated NOLOGIN role instead of postgres.
create or replace function public.tasks_guard() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare trusted_writer boolean := current_user not in ('authenticated', 'anon');
begin
  if auth.uid() is null then return new; end if;   -- service role / maintenance, as in 0002
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not trusted_writer then
      new.source := 'manual';
      new.external_reference := null;
    end if;
  elsif new.created_by is distinct from old.created_by
     or new.source is distinct from old.source
     or new.external_reference is distinct from old.external_reference
     or new.created_at is distinct from old.created_at then
    raise exception 'created_by, source, external_reference and created_at are immutable'
      using errcode = '42501';
  end if;
  if not public.is_admin()
     and new.assigned_to is not null
     and new.assigned_to <> auth.uid()
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    raise exception 'only administrators can assign tasks to other people' using errcode = '42501';
  end if;
  return new;
end $$;

-- Approval. One transaction: authorization, row lock, task, decision record, confirmed owner and audit event.
-- The audit event exists only if the decision committed: it cannot report a decision that did not take effect.
-- The task's own `task_created` / `task_assigned` events come from the existing tasks_log_activity trigger (0001):
-- this function does NOT write a second task_created.
-- The handle is the OPAQUE review_id (uuid), never the dedupe key / Message-ID. Unknown id -> P0002 (no_data_found), only AFTER
-- the administrator check, so a non-admin cannot learn whether an id exists. p_priority defaults to 'medium' (an explicit NULL
-- would otherwise fail the NOT NULL column).
create function public.ai_approve_message(
  p_review_id uuid, p_title text, p_description text,
  p_assigned_to uuid, p_due_at timestamptz, p_priority text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  m public.ai_messages;
  new_task uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'only administrators can approve AI-proposed tasks' using errcode = '42501';
  end if;
  select * into m from public.ai_messages where review_id = p_review_id for update;  -- serialises racers
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  if m.status <> 'REVIEW_REQUIRED' then
    raise exception 'message is not awaiting review' using errcode = '55000';          -- the loser of a race lands here
  end if;
  insert into public.tasks (title, description, priority, assigned_to, due_at, source, external_reference)
  values (p_title, p_description, coalesce(p_priority, 'medium'), p_assigned_to, p_due_at, 'email',
          encode(sha256(convert_to(m.dedupe_key, 'utf8')), 'hex'))
  returning id into new_task;
  update public.ai_messages
     set status = 'TASK_CREATED', task_id = new_task, reviewed_by = auth.uid(), reviewed_at = now(),
         confirmed_owner = jsonb_build_object('user_id', p_assigned_to, 'confirmed_by', auth.uid(), 'confirmed_at', now())
   where review_id = p_review_id;
  insert into public.activity_events (event_type, description, status, actor_id, related_task_id, metadata)
  values ('message_classified', 'Proposal approved by a reviewer', 'processed', auth.uid(), new_task, jsonb_build_object(
    'workflow_id', m.workflow_id, 'decision', 'approved', 'outcome', 'APPROVED', 'actor_kind', 'user',
    'classifier_mode', m.classifier ->> 'mode', 'fallback_reason', m.classifier ->> 'fallback_reason',
    'flags', to_jsonb(m.risk_flags), 'event_key', m.workflow_id || ':message_classified:audit:approved:0'))
  on conflict ((metadata ->> 'event_key')) where metadata ? 'event_key' do nothing;
  return new_task;
end $$;
-- Browser role only: signed-in users (the administrator check is inside). Not service_role, not PUBLIC, not anon.
revoke all on function public.ai_approve_message(uuid, text, text, uuid, timestamptz, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_approve_message(uuid, text, text, uuid, timestamptz, text) to authenticated;

-- Rejection: same shape, admin only, one-time (compare-and-set on status), audit event in the same transaction.
create function public.ai_reject_message(p_review_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.ai_messages;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'only administrators can reject AI-proposed tasks' using errcode = '42501';
  end if;
  update public.ai_messages
     set status = 'REJECTED', reviewed_by = auth.uid(), reviewed_at = now()
   where review_id = p_review_id and status = 'REVIEW_REQUIRED'
  returning * into m;
  if not found then
    if not exists (select 1 from public.ai_messages where review_id = p_review_id) then
      raise exception 'message not found' using errcode = 'P0002';
    end if;
    raise exception 'message is not awaiting review' using errcode = '55000';
  end if;
  insert into public.activity_events (event_type, description, status, actor_id, metadata)
  values ('message_classified', 'Proposal rejected by a reviewer', 'processed', auth.uid(), jsonb_build_object(
    'workflow_id', m.workflow_id, 'decision', 'rejected', 'outcome', 'REJECTED', 'actor_kind', 'user',
    'classifier_mode', m.classifier ->> 'mode', 'fallback_reason', m.classifier ->> 'fallback_reason',
    'flags', to_jsonb(m.risk_flags), 'event_key', m.workflow_id || ':message_classified:audit:rejected:0'))
  on conflict ((metadata ->> 'event_key')) where metadata ? 'event_key' do nothing;
end $$;
revoke all on function public.ai_reject_message(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ai_reject_message(uuid) to authenticated;

-- ROLLBACK (additive migration): drop function ai_reject_message(uuid), ai_approve_message(uuid,text,text,uuid,timestamptz,text),
-- ai_record_audit_event(text,text,text,uuid,uuid,jsonb); drop index activity_events_event_key_uidx, tasks_source_external_reference_uidx;
-- drop table ai_messages; restore the 0002 tasks_guard definition.

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
