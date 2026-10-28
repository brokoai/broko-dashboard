-- ============================================================================================
-- PROPOSED, NOT APPLIED. Central AI Brain, slice 1.1: a METADATA-ONLY audit trail of chat questions.
-- Depends on 0001 (public.profiles, public.is_admin()). Additive only: no drops, no data changes. Independent of 0007.
-- Verified only on a local PostgreSQL (supabase/proposed/tests/0008_chat_audit.pglite.mjs). NOT yet run on any remote project.
--
-- WHAT IS STORED: who asked, when, which fixed intent the Brain chose, which source types it read, how many records the answer
--   rested on, whether the optional model router was used, how long it took, and the outcome. NOTHING ELSE.
-- WHAT IS NEVER STORED: the message text, any prompt, any model output, any answer text, any record content, any error text.
--   The database enforces this shape (fixed vocabularies and bounded numbers, no free-text column), so a buggy or hostile client
--   cannot use this table to keep conversation content.
--
-- WHO CAN DO WHAT:
--   insert : any signed-in user, only as themself (actor_id = auth.uid()), only the columns listed below. created_at is set by
--            the database and cannot be supplied. A per-user burst cap (trigger below) stops one account flooding the table.
--   read   : administrators only. A member's query returns no rows (not even their own); nothing is disclosed to non-admins.
--   update / delete : nobody, through the API. (Retention is a separate, admin-run step in a later slice.)
--
-- TENANCY (designed for, NOT implemented): organization_id is reserved and left NULL. It is not writable by clients and has no
--   foreign key because no organizations table exists. Single-company behaviour is unchanged. To add multi-company later:
--   create public.organizations, backfill this column (and set it NOT NULL), set it from the caller's profile in a trigger, and
--   add `organization_id = <caller's organization>` to the read policy. No other change to this table is needed.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
select set_config('broko.prev_role', current_user, false);
set role postgres;

create table public.chat_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,                                    -- reserved for future tenant isolation; always NULL today
  actor_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  -- The Brain's fixed intent vocabulary (src/lib/ai-brain/chat/types.ts ChatIntent). NULL when the call failed before routing.
  intent text check (intent in ('attention', 'pending_tasks', 'today', 'overdue', 'upcoming', 'priority', 'owners', 'notifications', 'ai_inbox',
                                'integrations', 'sources', 'summary', 'preconstruction', 'action_request', 'blocked', 'clarify', 'unsupported', 'help')),
  outcome text not null check (outcome in ('answered', 'unsupported', 'clarification', 'approval_required', 'blocked', 'rejected', 'error')),
  project_id uuid,                                         -- the project the user scoped the question to, if any (no foreign key: the log outlives it)
  -- Source types read for this answer (SourceId). A subset of the fixed list, never free text.
  source_ids text[] not null default '{}'
    check (cardinality(source_ids) <= 12
           and source_ids <@ array['tasks', 'activity', 'notifications', 'ai_inbox', 'integrations', 'email', 'teams', 'whatsapp', 'calendar', 'crm', 'documents', 'preconstruction']),
  record_count integer not null default 0 check (record_count between 0 and 100000),
  has_evidence boolean not null default false,
  used_model boolean not null default false,               -- true only when the optional model router chose the intent
  latency_ms integer not null default 0 check (latency_ms between 0 and 600000)
);
create index chat_audit_actor_idx on public.chat_audit (actor_id, created_at desc);
create index chat_audit_created_idx on public.chat_audit (created_at desc);
create index chat_audit_org_idx on public.chat_audit (organization_id, created_at desc);

-- Burst cap: at most 120 rows per user per minute. It is a safety net against direct API abuse; the app's own limits are far lower.
-- SECURITY DEFINER on purpose: members cannot read this table (admin-only policy below), so a trigger running as the caller would
-- always count zero rows and the cap would silently never fire. The function counts the caller's own rows as its owner (postgres),
-- pins an empty search_path, schema-qualifies every name, and no API role may execute it directly (revoked below).
-- CONCURRENCY: under READ COMMITTED, two simultaneous requests would each count the other's uncommitted rows as absent and could
-- both pass at 119. A transaction-scoped advisory lock keyed on the user serializes that user's inserts, so the second request
-- waits for the first to commit and then sees its rows. The lock is taken only when the row is for the caller themself
-- (actor_id = auth.uid()); a forged actor_id is rejected by row level security anyway, and must not be able to hold another user's lock.
-- Inserts made by a trusted maintenance role (no JWT, auth.uid() is null) are not capped.
create function public.chat_audit_burst_cap() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if new.actor_id is null or new.actor_id is distinct from auth.uid() then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_audit:' || new.actor_id::text, 0));
  if (select count(*) from public.chat_audit a where a.actor_id = new.actor_id and a.created_at > now() - interval '1 minute') >= 120 then
    raise exception 'chat audit rate limit' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger chat_audit_burst_cap before insert on public.chat_audit for each row execute function public.chat_audit_burst_cap();
revoke all on function public.chat_audit_burst_cap() from public, anon, authenticated, service_role;

alter table public.chat_audit enable row level security;
create policy chat_audit_read on public.chat_audit for select to authenticated
  using (public.is_admin());
create policy chat_audit_insert on public.chat_audit for insert to authenticated
  with check (actor_id = auth.uid());

-- Supabase auto-grants every privilege on new public tables to anon/authenticated/service_role (including TRUNCATE, which RLS does
-- not stop). Revoke everything, then grant back only what the app needs. Nothing goes to anon or service_role.
revoke all on public.chat_audit from public, anon, authenticated, service_role;
grant select on public.chat_audit to authenticated;
grant insert (actor_id, intent, outcome, project_id, source_ids, record_count, has_evidence, used_model, latency_ms) on public.chat_audit to authenticated;

-- ROLLBACK (manual; destroys the audit rows): drop table public.chat_audit; drop function public.chat_audit_burst_cap();

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
