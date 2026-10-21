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
-- OPEN DECISION: the guard must honour a transaction-local flag that only this function sets.
-- Review that set_config('broko.trusted_source', ...) cannot be reached from a client session
-- (it is not exposed through PostgREST) before accepting this design.
create or replace function public.tasks_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare trusted boolean := coalesce(current_setting('broko.trusted_source', true), '') = 'email';
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not trusted then
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
  perform set_config('broko.trusted_source', 'email', true);                           -- transaction-local
  insert into public.tasks (title, description, priority, assigned_to, due_at, source, external_reference)
  values (p_title, p_description, p_priority, p_assigned_to, p_due_at, 'email',
          encode(sha256(convert_to(m.dedupe_key, 'utf8')), 'hex'))
  returning id into new_task;
  perform set_config('broko.trusted_source', '', true);
  update public.ai_messages
     set status = 'TASK_CREATED', task_id = new_task, reviewed_by = auth.uid()
   where dedupe_key = p_dedupe_key;
  return new_task;
end $$;
revoke all on function public.ai_approve_message(text, text, text, uuid, timestamptz, text) from public, anon;
grant execute on function public.ai_approve_message(text, text, text, uuid, timestamptz, text) to authenticated;
