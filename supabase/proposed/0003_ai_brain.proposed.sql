-- ============================================================================================
-- PROPOSED — NOT APPLIED. Do not run against any database without explicit approval.
-- Broko AI Brain, Phase 1: persistence for the Communication Agent.
-- Depends on 0001_init.sql and 0002_hardening.proposed.sql (is_admin(), tasks_guard).
-- Untested against a real database: review with a disposable Supabase branch first.
-- ============================================================================================

-- -------------------------------------------------------------------------- ai_messages
-- One row per processed email. Mirrors ProcessedMessage in src/lib/ai-brain/schema.ts.
-- No email body is stored (data minimisation); `excerpt` stays NULL unless the organisation's
-- policy sets retain_excerpt_chars > 0.
create table public.ai_messages (
  dedupe_key text primary key,            -- RFC 5322 Message-ID preferred; see dedupeKey()
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
  grounding_notes text[] not null default '{}',
  risk_flags text[] not null default '{}',
  owner jsonb not null,                    -- { user_id, rule_id, reason } from configured rules
  review_reasons text[] not null default '{}',
  proposed_priority text check (proposed_priority in ('low', 'medium', 'high', 'urgent')),
  proposed_due_at timestamptz,
  task_id uuid references public.tasks (id) on delete set null,
  notification jsonb not null default '{"attempted": false, "sent": false}',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  error jsonb,                             -- { stage, message } sanitised
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_messages_status_idx on public.ai_messages (status, created_at desc);

create trigger ai_messages_touch before update on public.ai_messages
  for each row execute function public.touch_updated_at();

alter table public.ai_messages enable row level security;
-- Administrators review; nobody writes from the browser. The worker uses the service role
-- (auth.uid() is null), which bypasses RLS. There are deliberately no insert/update policies.
create policy ai_messages_select on public.ai_messages for select to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------- task idempotency at the database
-- A given email can become at most one task, whatever the application does.
create unique index tasks_source_external_reference_uidx
  on public.tasks (source, external_reference) where external_reference is not null;

-- --------------------------------------------------- approval: the only path that sets source
-- 0002's tasks_guard forces every human-inserted task to source='manual'. Approval must create a
-- task with source='email' atomically with the status change, and only for administrators.
--
-- REVIEW OF THE FIRST DRAFT (a transaction-local flag set with set_config and read by the guard):
-- rejected. It makes a security rule depend on a custom setting that any code path able to run
-- SQL in the session can also set. Replaced by a privilege-based test: the guard is SECURITY INVOKER,
-- so `current_user` is the role actually executing the INSERT. A browser session runs as
-- 'authenticated' (or 'anon') and is forced to source='manual' exactly as in 0002. Only the
-- SECURITY DEFINER function below (owned by a privileged role, admin-checked inside) executes the
-- INSERT as a different role, so only it can set source='email'. No client-writable state is trusted.
--
-- STILL OPEN, to verify on a disposable Supabase branch before any approval:
--  1. `current_user` inside a trigger fired by a SECURITY DEFINER function is the definer (expected).
--  2. is_admin() still works from an invoker trigger (it is itself SECURITY DEFINER).
--  3. The function owner is not 'authenticated'/'anon' and cannot be assumed by clients.
--  4. Whether the privileged owner should be a dedicated NOLOGIN role instead of postgres.
create or replace function public.tasks_guard() returns trigger
language plpgsql security invoker set search_path = public as $$
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

create function public.ai_approve_message(
  p_dedupe_key text, p_title text, p_description text,
  p_assigned_to uuid, p_due_at timestamptz, p_priority text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  m public.ai_messages;
  new_task uuid;
begin
  if not public.is_admin() then
    raise exception 'only administrators can approve AI-proposed tasks' using errcode = '42501';
  end if;
  select * into m from public.ai_messages where dedupe_key = p_dedupe_key for update;  -- serialises racers
  if not found then raise exception 'message not found'; end if;
  if m.status <> 'REVIEW_REQUIRED' then
    raise exception 'message is not awaiting review' using errcode = '55000';          -- loser of a race
  end if;
  insert into public.tasks (title, description, priority, assigned_to, due_at, source, external_reference)
  values (p_title, p_description, p_priority, p_assigned_to, p_due_at, 'email',
          encode(sha256(convert_to(m.dedupe_key, 'utf8')), 'hex'))
  returning id into new_task;
  update public.ai_messages
     set status = 'TASK_CREATED', task_id = new_task, reviewed_by = auth.uid(), reviewed_at = now()
   where dedupe_key = p_dedupe_key;
  return new_task;
end $$;
revoke all on function public.ai_approve_message(text, text, text, uuid, timestamptz, text) from public, anon;
grant execute on function public.ai_approve_message(text, text, text, uuid, timestamptz, text) to authenticated;

-- Rejection: same shape, admin only, one-time (compare-and-set on status).
create function public.ai_reject_message(p_dedupe_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'only administrators can reject AI-proposed tasks' using errcode = '42501';
  end if;
  update public.ai_messages
     set status = 'REJECTED', reviewed_by = auth.uid(), reviewed_at = now()
   where dedupe_key = p_dedupe_key and status = 'REVIEW_REQUIRED';
  if not found then raise exception 'message is not awaiting review' using errcode = '55000'; end if;
end $$;
revoke all on function public.ai_reject_message(text) from public, anon;
grant execute on function public.ai_reject_message(text) to authenticated;
