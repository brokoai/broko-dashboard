-- ============================================================================================
-- PROPOSED, NOT APPLIED. Do not run against any database without explicit approval.
-- NOT APPROVED FOR APPLICATION (phase closure 2026-10-25): depends on 0003, and no Supabase repository or background worker
-- uses it yet. Revisit only together with the AI Inbox Supabase integration.
-- Broko AI Brain: durable background jobs (queue, leases, retries). Postgres is the queue, so no external queue
-- service is needed. Depends on 0001 (is_admin, touch_updated_at) and 0003 (ai_record_audit_event).
--
-- STATUS: executed locally on PGlite only (supabase/proposed/tests/mutation_checks.pglite.mjs runs it with the
-- 0004_rls_and_jobs.proposed.sql script, which FAILS when each control below is removed). NOT run on real Supabase. A single
-- PGlite session cannot prove two-session behaviour: FOR UPDATE SKIP LOCKED is pinned as text by tests/sql-security.test.ts and
-- must be verified with the manual two-session procedure at the bottom of the test script on a real PostgreSQL.
-- Mirrors JobStore (src/lib/ai-brain/jobs.ts) and the in-memory test double (memory-jobs.ts).
--
-- PRIVILEGES ARE EXPLICIT (final state, not the platform defaults): ai_jobs is read-only for API roles. authenticated and
-- service_role get SELECT; every state change goes through the fenced functions below, so no role can bypass the lease fence
-- with a plain UPDATE, and none can DELETE, TRUNCATE, REFERENCE or add triggers.
--
-- A job holds a REFERENCE to a message, never its content. "completed" means classified, never approved.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
-- On the dev project the CLI's login role (cli_login_postgres) is a member of postgres with SET but NOT INHERIT and has no
-- CREATE on schema public, so objects can only be created after SET ROLE postgres (this also makes postgres the owner).
-- The previous role is saved and restored at the end instead of `reset role`: if the CLI had already switched to postgres, a
-- plain `reset role` would drop it back to the login role and the CLI's own migration-history insert, queued after this file,
-- would fail. Saving and restoring is correct whether or not the CLI switched first, and when run in the SQL editor.
select set_config('broko.prev_role', current_user, false);
set role postgres;

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),   -- INTERNAL row id. No function takes or promises it; the app never sees it.
  job_key text not null unique,            -- idempotency key: the compact JSON array [provider, mailbox_ref, source_message_id], exactly
                                           -- as jobKey() in jobs.ts writes it. JSON quoting makes it unambiguous: no choice of field
                                           -- contents (a "|" in a mailbox ref, say) can make two different messages share a key.
  -- THE PUBLIC JOB ID (the only job identifier in any function signature, UI view model or log): 12 lower-case hex characters,
  -- the first 12 of sha256(job_key), identical to jobId() in jobs.ts. Unique, so a (practically impossible) hash collision makes
  -- the insert fail instead of letting two jobs share an id.
  correlation_id text not null unique check (correlation_id ~ '^[0-9a-f]{12}$'),
  provider text not null check (provider in ('microsoft_graph', 'gmail', 'synthetic')),
  mailbox_ref text not null,
  source_message_id text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry_wait', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  workflow_id text,                        -- hashed message identity, known once the message was read
  outcome text,                            -- message status reached, or 'duplicate'. Never an approval.
  error_category text check (error_category in (
    'invalid_input', 'classification_failed', 'invalid_model_output', 'task_creation_failed', 'task_creation_denied',
    'notification_failed', 'processing_interrupted', 'internal_error')),
  audit_failed boolean not null default false,
  requeued_by uuid references public.profiles (id) on delete set null,
  requeued_at timestamptz,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ai_jobs_attempts_bounded check (attempts <= max_attempts),
  constraint ai_jobs_lease_consistent check ((status = 'processing') = (lease_owner is not null and lease_expires_at is not null)),
  constraint ai_jobs_outcome_not_approval check (outcome is null or outcome not in ('APPROVED', 'TASK_CREATED', 'NOTIFICATION_SENT')),
  -- Same limits as the application schema (MessageRef): a reference cannot be empty or unbounded.
  constraint ai_jobs_ref_lengths check (char_length(mailbox_ref) <= 200 and char_length(source_message_id) between 1 and 512)
);
-- Fast lookup of work that is ready to claim.
create index ai_jobs_claimable_idx on public.ai_jobs (next_attempt_at, enqueued_at)
  where status in ('queued', 'retry_wait');
create index ai_jobs_lease_idx on public.ai_jobs (lease_expires_at) where status = 'processing';
create index ai_jobs_workflow_idx on public.ai_jobs (workflow_id);

create trigger ai_jobs_touch before update on public.ai_jobs
  for each row execute function public.touch_updated_at();

alter table public.ai_jobs enable row level security;
create policy ai_jobs_select on public.ai_jobs for select to authenticated using (public.is_admin());
-- Supabase's default privileges give anon/authenticated/service_role EVERY table privilege (incl. TRUNCATE, which RLS does not
-- stop). Remove them all, then grant back SELECT only (authenticated is further limited to administrators by the policy above).
revoke all on public.ai_jobs from public, anon, authenticated, service_role;
grant select on public.ai_jobs to authenticated;
grant select on public.ai_jobs to service_role;

-- ------------------------------------------------------------------------------ worker functions
-- All run as the service role (the worker's server-side credential, never in a browser). Each is atomic.

create function public.ai_enqueue_job(p_provider text, p_mailbox_ref text, p_source_message_id text, p_max_attempts integer default 3)
returns text   -- the public job id (correlation_id)
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := array_to_json(array[p_provider, p_mailbox_ref, p_source_message_id])::text;   -- canonical, unambiguous (see job_key)
  v_id text;
begin
  if p_provider is null or p_mailbox_ref is null or p_source_message_id is null then
    raise exception 'job reference incomplete' using errcode = '22023';
  end if;
  insert into public.ai_jobs (job_key, correlation_id, provider, mailbox_ref, source_message_id, max_attempts)
  values (v_key, substr(encode(sha256(convert_to(v_key, 'utf8')), 'hex'), 1, 12), p_provider, p_mailbox_ref, p_source_message_id, p_max_attempts)
  on conflict (job_key) do nothing
  returning correlation_id into v_id;
  if v_id is null then select correlation_id into v_id from public.ai_jobs where job_key = v_key; end if;   -- idempotent: the existing job
  return v_id;
end $$;

-- Claims at most one eligible job: ready queued/retry_wait, or processing whose lease expired. Abandoned jobs with no
-- attempts left are failed (processing_interrupted) instead of looping forever. FOR UPDATE SKIP LOCKED means two workers
-- can never take the same row.
create function public.ai_claim_job(p_worker text, p_lease_seconds integer)
returns setof public.ai_jobs
language plpgsql security definer set search_path = '' as $$
declare j public.ai_jobs;
begin
  -- A lease that is too short lets a second worker take a job that is still running; one that is too long hides a crashed
  -- worker. The application default is 60 s (JOB_DEFAULTS.leaseMs). Out-of-range or missing values are refused, not clamped.
  if p_lease_seconds is null or p_lease_seconds not between 10 and 3600 then
    raise exception 'lease must be between 10 and 3600 seconds' using errcode = '22023';
  end if;
  if p_worker is null or char_length(p_worker) not between 1 and 100 then
    raise exception 'invalid worker name' using errcode = '22023';
  end if;
  for j in
    update public.ai_jobs
       set status = 'failed', error_category = 'processing_interrupted', lease_owner = null, lease_expires_at = null,
           finished_at = now()
     where status = 'processing' and lease_expires_at <= now() and attempts >= max_attempts
    returning *
  loop
    perform public.ai_record_audit_event('workflow_failed', 'failed', 'Workflow failed: processing was interrupted', null, null,
      jsonb_build_object('workflow_id', j.workflow_id, 'outcome', 'FAILED', 'error_category', 'processing_interrupted',
        'event_key', coalesce(j.workflow_id, j.correlation_id) || ':workflow_failed:ingest:-:' || j.attempts));
  end loop;

  select * into j from public.ai_jobs
   where (status in ('queued', 'retry_wait') and next_attempt_at <= now())
      or (status = 'processing' and lease_expires_at <= now() and attempts < max_attempts)
   order by next_attempt_at, enqueued_at
   for update skip locked
   limit 1;
  if not found then return; end if;

  update public.ai_jobs
     set status = 'processing', attempts = attempts + 1, lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(started_at, now()), error_category = null
   where id = j.id
  returning * into j;
  return next j;
end $$;

-- Fenced completion: only the current lease holder, on the attempt it claimed, may report. A stale worker gets false.
create function public.ai_complete_job(p_job_id text, p_worker text, p_attempt integer, p_workflow_id text, p_outcome text, p_audit_failed boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_jobs
     set status = 'completed', workflow_id = p_workflow_id, outcome = p_outcome, audit_failed = audit_failed or p_audit_failed,
         error_category = null, lease_owner = null, lease_expires_at = null, finished_at = now()
   where correlation_id = p_job_id and status = 'processing' and lease_owner = p_worker and attempts = p_attempt;
  return found;
end $$;

create function public.ai_retry_job(p_job_id text, p_worker text, p_attempt integer, p_error text, p_run_at timestamptz, p_workflow_id text, p_audit_failed boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_run timestamptz;
begin
  -- The retry time comes from the worker's clock and backoff (application default cap: 5 minutes). It is required, and bounded
  -- here so a bad value can neither retry in the past (a hot loop) nor park the job for years: clamped to [now, now + 24 h].
  if p_run_at is null then raise exception 'retry time required' using errcode = '22023'; end if;
  v_run := least(greatest(p_run_at, now()), now() + interval '24 hours');
  update public.ai_jobs
     set status = 'retry_wait', error_category = p_error, next_attempt_at = v_run, workflow_id = coalesce(p_workflow_id, workflow_id),
         audit_failed = audit_failed or p_audit_failed, lease_owner = null, lease_expires_at = null
   where correlation_id = p_job_id and status = 'processing' and lease_owner = p_worker and attempts = p_attempt and attempts < max_attempts;
  return found;
end $$;

create function public.ai_fail_job(p_job_id text, p_worker text, p_attempt integer, p_error text, p_workflow_id text, p_audit_failed boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_jobs
     set status = 'failed', error_category = p_error, workflow_id = coalesce(p_workflow_id, workflow_id),
         audit_failed = audit_failed or p_audit_failed, lease_owner = null, lease_expires_at = null, finished_at = now()
   where correlation_id = p_job_id and status = 'processing' and lease_owner = p_worker and attempts = p_attempt;
  return found;
end $$;

-- Administrator recovery: failed -> queued with a fresh attempt budget. Records who did it. No audit event is written
-- for this (the existing event taxonomy has no suitable type); the job row is the record.
create function public.ai_requeue_job(p_job_id text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'only administrators can retry a failed job' using errcode = '42501';
  end if;
  update public.ai_jobs
     set status = 'queued', attempts = 0, error_category = null, outcome = null, next_attempt_at = now(),
         requeued_by = auth.uid(), requeued_at = now(), finished_at = null
   where correlation_id = p_job_id and status = 'failed';
  return found;
end $$;

-- Execution rights. Worker functions: service role only. Requeue: signed-in users, administrator-checked inside.
-- Every function is revoked from ALL four principals first (never relying on the defaults), then granted to exactly one role.
revoke all on function public.ai_enqueue_job(text, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_claim_job(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_complete_job(text, text, integer, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.ai_retry_job(text, text, integer, text, timestamptz, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.ai_fail_job(text, text, integer, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.ai_enqueue_job(text, text, text, integer) to service_role;
grant execute on function public.ai_claim_job(text, integer) to service_role;
grant execute on function public.ai_complete_job(text, text, integer, text, text, boolean) to service_role;
grant execute on function public.ai_retry_job(text, text, integer, text, timestamptz, text, boolean) to service_role;
grant execute on function public.ai_fail_job(text, text, integer, text, text, boolean) to service_role;
revoke all on function public.ai_requeue_job(text) from public, anon, authenticated, service_role;
grant execute on function public.ai_requeue_job(text) to authenticated;   -- administrator-checked inside; not callable by service_role

-- ROLLBACK (additive): drop functions ai_requeue_job, ai_fail_job, ai_retry_job, ai_complete_job, ai_claim_job, ai_enqueue_job;
-- drop table public.ai_jobs.

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
