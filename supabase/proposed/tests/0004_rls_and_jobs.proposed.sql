-- ============================================================================================
-- PROPOSED TEST SCRIPT. Run ONLY on an approved, ISOLATED development Supabase project that has had
-- 0001, 0002, 0003 and 0004 applied. NEVER on a shared, staging or production database: it creates users and rows.
-- Everything runs inside one transaction and is rolled back at the end (see the last line), including the temporary GRANTs
-- used to prove that the guards hold even if column privileges were widened by mistake.
--
-- STATUS: executed locally on PGlite by supabase/proposed/tests/mutation_checks.pglite.mjs, which also proves that this script
-- FAILS when each of these controls is deliberately removed (admin check on approval, task guard, integration guard, lease
-- fence attempt counter in complete/retry/fail, lease and retry bounds, ambiguous job key, table over-grants, last-admin guard,
-- trigger-function EXECUTE revokes). NOT yet run on real Supabase.
--
-- It checks: RLS visibility, administrator-only functions, approval by the OPAQUE review_id (and refusal of any other handle),
-- one-task-per-approval, atomic idempotent decisions with the real reviewer and server time, privacy of audit metadata,
-- EXACT table privileges and function EXECUTE rights for anon, authenticated, service_role and PUBLIC (no DELETE, TRUNCATE,
-- REFERENCES or TRIGGER anywhere; service_role cannot write ai_jobs directly), claim/lease/fencing (including a re-claim by the
-- SAME worker name), lease-length and retry-time bounds, an unambiguous job key, abandoned-job recovery, the database-side task
-- and integration guards, and the last-administrator guard (including deleting the auth user, which cascades to the profile).
-- Each check raises an exception when violated. If the script ends with NOTICE 'ALL CHECKS PASSED' nothing failed.
--
-- WHAT THIS SCRIPT CANNOT PROVE (one session only): FOR UPDATE SKIP LOCKED, row-lock waiting between two approvals, and any
-- behaviour that depends on two transactions overlapping. Do the two-session procedure at the bottom by hand on a real
-- PostgreSQL/Supabase database. A single-session run, on PGlite or anywhere else, says nothing about concurrency.
-- ============================================================================================
begin;

-- Fixtures (synthetic). Requires privileges to write auth.users (true in a development project's SQL editor).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin.test@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'member.test@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'member2.test@example.test')
on conflict do nothing;
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a1';

insert into public.ai_messages (review_id, dedupe_key, workflow_id, provider, source_message_id, mailbox_ref, received_at, sender_email, subject,
                                status, owner, risk_flags, classifier)
values ('11111111-1111-4111-8111-111111111111', 'test|synthetic|k1', 'aaaaaaaaaaaa', 'synthetic', 'syn-1', 'box', now(), 'sender@example.test', 'Synthetic subject',
        'REVIEW_REQUIRED', '{"user_id": null, "rule_id": null, "reason": "test"}', '{sender_unverified}', '{"mode":"rules","fallback_reason":null}'),
       ('22222222-2222-4222-8222-222222222222', 'test|synthetic|k2', 'bbbbbbbbbbbb', 'synthetic', 'syn-2', 'box', now(), 'sender2@example.test', 'Synthetic subject 2',
        'REVIEW_REQUIRED', '{"user_id": null, "rule_id": null, "reason": "test"}', '{}', '{"mode":"rules","fallback_reason":null}');

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
end $$;
create or replace function pg_temp.act_as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role service_role';
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', true); end $$;
create or replace function pg_temp.expect_error(stmt text, code text) returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin
    execute stmt;
  exception when others then
    failed := true;
    if sqlstate <> code then raise exception 'CHECK FAILED: expected % but got % (%) from: %', code, sqlstate, sqlerrm, stmt; end if;
  end;
  -- Checked OUTSIDE the handler, so a statement that wrongly succeeds is always caught (even when the expected code is P0001).
  if not failed then raise exception 'CHECK FAILED: expected % but the statement succeeded: %', code, stmt; end if;
end $$;

-- 1. RLS: a member sees no AI messages or jobs; an administrator sees them.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  if (select count(*) from public.ai_messages) <> 0 then raise exception 'CHECK FAILED: member can read ai_messages'; end if;
  if (select count(*) from public.ai_jobs) <> 0 then raise exception 'CHECK FAILED: member can read ai_jobs'; end if;
end $$;
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  if (select count(*) from public.ai_messages) <> 2 then raise exception 'CHECK FAILED: admin cannot read ai_messages'; end if;
end $$;

-- 2. Browser roles cannot write AI tables or call worker functions.
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_error($q$ update public.ai_messages set status = 'TASK_CREATED' where dedupe_key = 'test|synthetic|k1' $q$, '42501');
select pg_temp.expect_error($q$ insert into public.ai_jobs (job_key, correlation_id, provider, mailbox_ref, source_message_id) values ('x','x','synthetic','b','s') $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_claim_job('w', 60) $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('message_classified','processed','x',null,null,'{"event_key":"k"}') $q$, '42501');
-- No browser role can delete or truncate AI data, even an administrator (RLS does not stop TRUNCATE; only the privilege does).
select pg_temp.expect_error($q$ delete from public.ai_messages $q$, '42501');
select pg_temp.expect_error($q$ truncate public.ai_messages $q$, '42501');
select pg_temp.expect_error($q$ delete from public.ai_jobs $q$, '42501');
select pg_temp.expect_error($q$ truncate public.ai_jobs $q$, '42501');
select pg_temp.expect_error($q$ update public.ai_jobs set status = 'completed' $q$, '42501');
select pg_temp.reset_role();
-- The anonymous role sees and calls nothing.
select pg_temp.act_as_anon();
select pg_temp.expect_error($q$ select count(*) from public.ai_messages $q$, '42501');
select pg_temp.expect_error($q$ select count(*) from public.ai_jobs $q$, '42501');
select pg_temp.expect_error($q$ truncate public.ai_messages $q$, '42501');
select pg_temp.expect_error($q$ truncate public.ai_jobs $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_claim_job('w', 60) $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_approve_message('11111111-1111-4111-8111-111111111111'::uuid,'t','d',null,null,'medium') $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_reject_message('11111111-1111-4111-8111-111111111111'::uuid) $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_requeue_job('0123456789ab') $q$, '42501');
select pg_temp.reset_role();

-- 3. Members cannot approve, reject or requeue.
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect_error($q$ select public.ai_approve_message('11111111-1111-4111-8111-111111111111'::uuid,'t','d',null,null,'medium') $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_reject_message('11111111-1111-4111-8111-111111111111'::uuid) $q$, '42501');
-- A member gets the same answer for an id that does not exist: no oracle for which review ids are real.
select pg_temp.expect_error($q$ select public.ai_approve_message(gen_random_uuid(),'t','d',null,null,'medium') $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_reject_message(gen_random_uuid()) $q$, '42501');
select pg_temp.expect_error($q$ select public.ai_requeue_job('0123456789ab') $q$, '42501');
-- ...and a member cannot even NAME server-controlled task columns: 0001's column grants refuse it before any trigger runs.
select pg_temp.expect_error($q$ insert into public.tasks (title, source, external_reference) values ('member task', 'email', 'forged') $q$, '42501');
select pg_temp.expect_error($q$ update public.tasks set source = 'email' where false $q$, '42501');

-- 3b. DEFENCE IN DEPTH. The column grants above and the task guard (0002, replaced in 0003) are two independent layers.
-- Widen the grants for the rest of this transaction (undone by the final ROLLBACK) so that ONLY the guard stands in the way,
-- and prove the guard on its own: it forces source/external_reference on insert, and refuses edits of server-controlled
-- columns and reassignment to someone else. A guard that trusts every writer would let the first insert below keep 'email'.
select pg_temp.reset_role();
grant insert (source, external_reference), update (source, external_reference, created_by, created_at) on public.tasks to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
do $$ declare s text; r text; c uuid; begin
  insert into public.tasks (title, source, external_reference, created_by)
  values ('guarded member task', 'email', 'forged', '00000000-0000-0000-0000-0000000000b2') returning source, external_reference, created_by into s, r, c;
  if s <> 'manual' then raise exception 'CHECK FAILED: guard let a member keep source=% (guard trusts a client writer)', s; end if;
  if r is not null then raise exception 'CHECK FAILED: guard let a member keep external_reference'; end if;
  if c <> '00000000-0000-0000-0000-0000000000b1' then raise exception 'CHECK FAILED: guard let a member forge created_by'; end if;
end $$;
select pg_temp.expect_error($q$ update public.tasks set source = 'email' where title = 'guarded member task' $q$, '42501');
select pg_temp.expect_error($q$ update public.tasks set external_reference = 'x' where title = 'guarded member task' $q$, '42501');
select pg_temp.expect_error($q$ update public.tasks set created_by = '00000000-0000-0000-0000-0000000000b2' where title = 'guarded member task' $q$, '42501');
-- Reassignment (H-1): a member who may edit the task still cannot hand it to someone else, on insert or on update.
select pg_temp.expect_error($q$ update public.tasks set assigned_to = '00000000-0000-0000-0000-0000000000b2' where title = 'guarded member task' $q$, '42501');
select pg_temp.expect_error($q$ insert into public.tasks (title, assigned_to) values ('handed over', '00000000-0000-0000-0000-0000000000b2') $q$, '42501');
do $$ begin   -- assigning to oneself, and an unrelated edit, still work
  update public.tasks set assigned_to = '00000000-0000-0000-0000-0000000000b1', title = 'guarded member task (self)' where title = 'guarded member task';
  if not found then raise exception 'CHECK FAILED: a member could not assign a task to themselves'; end if;
end $$;
select pg_temp.reset_role();
-- Integration connection state (H-2): widen the privilege, then show the guard alone refuses an administrator session.
grant update on public.integrations to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_error($q$ update public.integrations set status = 'connected' where provider = 'gmail' $q$, '42501');
select pg_temp.expect_error($q$ update public.integrations set last_sync_at = now() where provider = 'gmail' $q$, '42501');
select pg_temp.expect_error($q$ update public.integrations set last_error = 'x' where provider = 'gmail' $q$, '42501');
select pg_temp.reset_role();

-- 4. Administrator approval: one task, real reviewer, server time, confirmed owner, one audit event, no second approval.
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
-- An id that names no message is refused (P0002) and changes nothing. The internal dedupe key is not a handle: it is not even a uuid.
select pg_temp.expect_error($q$ select public.ai_approve_message(gen_random_uuid(),'t','d',null,null,'medium') $q$, 'P0002');
select pg_temp.expect_error($q$ select public.ai_reject_message(gen_random_uuid()) $q$, 'P0002');
select pg_temp.expect_error($q$ select public.ai_approve_message('test|synthetic|k1'::uuid,'t','d',null,null,'medium') $q$, '22P02');
do $$ begin
  if (select count(*) from public.tasks where source = 'email') <> 0 then raise exception 'CHECK FAILED: a refused approval created a task'; end if;
  if (select count(*) from public.ai_messages where status = 'REVIEW_REQUIRED') <> 2 then raise exception 'CHECK FAILED: a refused handle changed a message'; end if;
end $$;
do $$ declare t uuid; begin
  t := public.ai_approve_message('11111111-1111-4111-8111-111111111111'::uuid, 'Proposed task', 'desc', '00000000-0000-0000-0000-0000000000b2', null, 'high');
  if t is null then raise exception 'CHECK FAILED: no task id'; end if;
end $$;
select pg_temp.expect_error($q$ select public.ai_approve_message('11111111-1111-4111-8111-111111111111'::uuid,'t','d',null,null,'medium') $q$, '55000');
select pg_temp.expect_error($q$ select public.ai_reject_message('11111111-1111-4111-8111-111111111111'::uuid) $q$, '55000');
do $$ declare m public.ai_messages; begin
  select * into m from public.ai_messages where dedupe_key = 'test|synthetic|k1';
  if m.status <> 'TASK_CREATED' or m.reviewed_by <> '00000000-0000-0000-0000-0000000000a1' or m.reviewed_at is null then
    raise exception 'CHECK FAILED: decision not recorded with reviewer and time'; end if;
  if (m.confirmed_owner ->> 'user_id') <> '00000000-0000-0000-0000-0000000000b2' or (m.confirmed_owner ->> 'confirmed_by') <> '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'CHECK FAILED: confirmed owner not recorded'; end if;
  if (select count(*) from public.tasks where source = 'email' and external_reference = encode(sha256(convert_to('test|synthetic|k1','utf8')),'hex')) <> 1 then
    raise exception 'CHECK FAILED: not exactly one task'; end if;
  if (select count(*) from public.activity_events where metadata ->> 'event_key' = 'aaaaaaaaaaaa:message_classified:audit:approved:0') <> 1 then
    raise exception 'CHECK FAILED: not exactly one approval event'; end if;
  if (select count(*) from public.activity_events where event_type = 'task_created' and related_task_id = m.task_id) <> 1 then
    raise exception 'CHECK FAILED: task_created must come only from the existing trigger, exactly once'; end if;
end $$;
do $$ begin  -- rejection path, and its event
  perform public.ai_reject_message('22222222-2222-4222-8222-222222222222'::uuid);
  if (select count(*) from public.activity_events where metadata ->> 'event_key' = 'bbbbbbbbbbbb:message_classified:audit:rejected:0') <> 1 then
    raise exception 'CHECK FAILED: rejection event missing'; end if;
end $$;

-- 5. Audit metadata is typed and content-free.
select pg_temp.reset_role();
do $$ begin
  if exists (select 1 from public.activity_events e, jsonb_object_keys(e.metadata) k
              where e.metadata ? 'event_key' and k not in ('workflow_id','classifier_mode','fallback_reason','intent','outcome','flags','error_category','decision','actor_kind','event_key')) then
    raise exception 'CHECK FAILED: untyped key in AI audit metadata'; end if;
  if exists (select 1 from public.activity_events where metadata::text ilike '%example.test%' or metadata::text ilike '%Synthetic subject%') then
    raise exception 'CHECK FAILED: email content in audit metadata'; end if;
end $$;

-- 6. Service role: idempotent audit events; claim, lease, fencing, abandonment.
-- service_role can only READ ai_jobs; every change goes through the fenced functions. So the steps that make a lease "expire" (a
-- crashed worker) are done by the table owner between the service-role blocks: pg_temp.expire() does exactly that and switches back.
create or replace function pg_temp.expire(ref text) returns void language plpgsql as $$
begin
  execute 'reset role';
  update public.ai_jobs set lease_expires_at = now() - interval '1 second' where source_message_id = ref;
  perform pg_temp.act_as_service();
end $$;
select pg_temp.act_as_service();
-- An unexpected metadata key (or untyped content) is refused; the error never echoes it.
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"z","subject":"leak"}') $q$, 'P0001');
-- Values are typed as well as keys: no free text, no oversized or malformed value can be stored through the function.
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v1","error_category":"Cannot read properties of undefined (reading x)"}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v2","workflow_id":"NOT-A-HASH"}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v3","workflow_id":{"nested":"object"}}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,jsonb_build_object('event_key', repeat('k', 121))) $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"Has Spaces And Capitals"}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v4","flags":"financial"}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v5","flags":["a free text flag"]}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v6","flags":["a","b","c","d","e","f","g","h","i","j","k","l","m"]}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v7","decision":"maybe"}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v8","classifier_mode":"gpt"}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v9","outcome":"free text here"}') $q$, 'P0001');
select pg_temp.expect_error($q$ select public.ai_record_audit_event('workflow_failed','pending','x',null,null,'{"event_key":"v10","intent":123}') $q$, 'P0001');
do $$ begin   -- a fully typed event (every key, nullable ones null) is accepted
  if public.ai_record_audit_event('message_classified','processed','Classified',null,null,
       '{"workflow_id":"dddddddddddd","classifier_mode":"llm","fallback_reason":null,"intent":"viewing_request","outcome":"REVIEW_REQUIRED","flags":["sender_unverified","financial"],"error_category":null,"decision":null,"actor_kind":"system","event_key":"dddddddddddd:message_classified:classify:-:1"}') <> true then
    raise exception 'CHECK FAILED: a fully typed event was refused'; end if;
end $$;
do $$ begin
  if public.ai_record_audit_event('workflow_failed','pending','Attempt failed, will retry: classification failed',null,null,
       '{"workflow_id":"cccccccccccc","error_category":"classification_failed","event_key":"cccccccccccc:workflow_failed:ingest:-:1"}') <> true then raise exception 'CHECK FAILED: first write'; end if;
  if public.ai_record_audit_event('workflow_failed','pending','Attempt failed, will retry: classification failed',null,null,
       '{"workflow_id":"cccccccccccc","error_category":"classification_failed","event_key":"cccccccccccc:workflow_failed:ingest:-:1"}') <> false then raise exception 'CHECK FAILED: duplicate event was written'; end if;
end $$;
do $$ declare id1 text; id2 text; j public.ai_jobs; begin
  id1 := public.ai_enqueue_job('synthetic', 'box', 'job-1', 2);
  id2 := public.ai_enqueue_job('synthetic', 'box', 'job-1', 2);
  if id1 <> id2 then raise exception 'CHECK FAILED: enqueue is not idempotent'; end if;
  select * into j from public.ai_claim_job('w1', 60);
  if j.correlation_id <> id1 or j.attempts <> 1 or j.status <> 'processing' then raise exception 'CHECK FAILED: claim'; end if;
  if (select count(*) from public.ai_claim_job('w2', 60)) <> 0 then raise exception 'CHECK FAILED: a live lease was claimed twice'; end if;
end $$;
select pg_temp.expire('job-1');      -- the worker "crashed"
do $$ declare id1 text; j public.ai_jobs; ok boolean; begin
  select correlation_id into id1 from public.ai_jobs where source_message_id = 'job-1';
  select * into j from public.ai_claim_job('w2', 60);
  if j.correlation_id <> id1 or j.attempts <> 2 or j.lease_owner <> 'w2' then raise exception 'CHECK FAILED: abandoned lease not recovered'; end if;
  ok := public.ai_complete_job(id1, 'w1', 1, 'aaaaaaaaaaaa', 'REVIEW_REQUIRED', false);          -- the stale worker returns
  if ok then raise exception 'CHECK FAILED: a stale worker overwrote the job (no fencing)'; end if;
  ok := public.ai_retry_job(id1, 'w2', 2, 'internal_error', now(), null, false);
  if ok then raise exception 'CHECK FAILED: retry accepted with no attempts left'; end if;
end $$;
select pg_temp.expire('job-1');      -- attempts exhausted and abandoned
do $$ declare id1 text; begin
  select correlation_id into id1 from public.ai_jobs where source_message_id = 'job-1';
  perform public.ai_claim_job('w3', 60);
  if (select status from public.ai_jobs where correlation_id = id1) <> 'failed' or (select error_category from public.ai_jobs where correlation_id = id1) <> 'processing_interrupted' then
    raise exception 'CHECK FAILED: exhausted abandoned job not failed'; end if;
  if (select count(*) from public.activity_events where event_type = 'workflow_failed' and metadata ->> 'error_category' = 'processing_interrupted') < 1 then
    raise exception 'CHECK FAILED: no event for the abandoned job'; end if;
  if (select outcome from public.ai_jobs where correlation_id = id1) is not null then raise exception 'CHECK FAILED: outcome set on a failed job'; end if;
end $$;
-- The SAME worker name claims again after its own lease expired. The fence is (lease_owner, attempts): with a reused worker
-- name only the attempt counter tells the stale first run from the current one. (A deployment that gives every worker the same
-- name, like the demo's "demo-worker", relies on this alone.)
do $$ declare id2 text; j public.ai_jobs; begin
  id2 := public.ai_enqueue_job('synthetic', 'box', 'job-same-owner', 3);
  select * into j from public.ai_claim_job('worker-A', 60);
  if j.correlation_id <> id2 or j.attempts <> 1 then raise exception 'CHECK FAILED: first claim by worker-A'; end if;
end $$;
select pg_temp.expire('job-same-owner');     -- worker-A hung; its lease expired
do $$ declare id2 text; j public.ai_jobs; ok boolean; begin
  select correlation_id into id2 from public.ai_jobs where source_message_id = 'job-same-owner';
  select * into j from public.ai_claim_job('worker-A', 60);                                     -- the SAME name claims again
  if j.correlation_id <> id2 or j.attempts <> 2 or j.lease_owner <> 'worker-A' then raise exception 'CHECK FAILED: re-claim by the same worker name'; end if;
  ok := public.ai_complete_job(id2, 'worker-A', 1, 'dddddddddddd', 'REVIEW_REQUIRED', false);  -- the stale first run returns
  if ok then raise exception 'CHECK FAILED: a stale run (attempt 1) completed a job that is on attempt 2 (attempt counter not part of the fence)'; end if;
  ok := public.ai_retry_job(id2, 'worker-A', 1, 'internal_error', now(), null, false);
  if ok then raise exception 'CHECK FAILED: a stale run (attempt 1) rescheduled the job'; end if;
  ok := public.ai_fail_job(id2, 'worker-A', 1, 'internal_error', null, false);
  if ok then raise exception 'CHECK FAILED: a stale run (attempt 1) failed the job'; end if;
  ok := public.ai_complete_job(id2, 'worker-A', 2, 'dddddddddddd', 'REVIEW_REQUIRED', false);  -- the current run can still finish
  if not ok then raise exception 'CHECK FAILED: the current run could not complete'; end if;
end $$;
select pg_temp.reset_role();

-- 6b. Lease length and retry time are bounded and validated, whoever the caller is.
select pg_temp.act_as_service();
select pg_temp.expect_error($q$ select public.ai_claim_job('w', 9) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job('w', 0) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job('w', -60) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job('w', 3601) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job('w', 2147483647) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job('w', null) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job('', 60) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job(null, 60) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_claim_job(repeat('x', 101), 60) $q$, '22023');
do $$ declare jid text; j public.ai_jobs; ok boolean; begin          -- both edges are accepted, and the lease is exactly as long as asked
  jid := public.ai_enqueue_job('synthetic', 'box', 'lease-min', 3);
  select * into j from public.ai_claim_job(repeat('x', 100), 10);
  if j.correlation_id <> jid or j.lease_expires_at <> now() + interval '10 seconds' then raise exception 'CHECK FAILED: a 10 s lease (or a 100-character worker name) was not honoured exactly'; end if;
  if not public.ai_fail_job(jid, repeat('x', 100), 1, 'internal_error', null, false) then raise exception 'CHECK FAILED: could not finish lease-min'; end if;
  jid := public.ai_enqueue_job('synthetic', 'box', 'lease-max', 3);
  select * into j from public.ai_claim_job('w', 3600);
  if j.correlation_id <> jid or j.lease_expires_at <> now() + interval '3600 seconds' then raise exception 'CHECK FAILED: a 3600 s lease was not honoured exactly'; end if;
  ok := public.ai_fail_job(jid, 'w', 1, 'internal_error', null, false);
  if not ok then raise exception 'CHECK FAILED: could not finish lease-max'; end if;
end $$;
-- Retry time: required, never in the past, never more than 24 hours ahead (the caller's value is clamped, not stored raw).
do $$ declare jid text; j public.ai_jobs; begin
  jid := public.ai_enqueue_job('synthetic', 'box', 'retry-clamp', 4);
  select * into j from public.ai_claim_job('wr', 60);
  if j.correlation_id <> jid then raise exception 'CHECK FAILED: retry-clamp claim'; end if;
  if not public.ai_retry_job(jid, 'wr', 1, 'internal_error', now() + interval '10 days', null, false) then raise exception 'CHECK FAILED: retry refused'; end if;
  if (select next_attempt_at from public.ai_jobs where correlation_id = jid) <> now() + interval '24 hours' then
    raise exception 'CHECK FAILED: a retry time 10 days ahead was not clamped to 24 hours (a worker could park a job forever)'; end if;
end $$;
select pg_temp.reset_role();
update public.ai_jobs set next_attempt_at = now() where source_message_id = 'retry-clamp';       -- owner makes it due again
select pg_temp.act_as_service();
do $$ declare jid text; j public.ai_jobs; begin
  select correlation_id into jid from public.ai_jobs where source_message_id = 'retry-clamp';
  select * into j from public.ai_claim_job('wr', 60);
  if j.correlation_id <> jid or j.attempts <> 2 then raise exception 'CHECK FAILED: retry-clamp second claim'; end if;
end $$;
select pg_temp.expect_error($q$ select public.ai_retry_job((select correlation_id from public.ai_jobs where source_message_id = 'retry-clamp'), 'wr', 2, 'internal_error', null, null, false) $q$, '22023');
do $$ declare jid text; begin
  select correlation_id into jid from public.ai_jobs where source_message_id = 'retry-clamp';
  if not public.ai_retry_job(jid, 'wr', 2, 'internal_error', now() - interval '3 days', null, false) then raise exception 'CHECK FAILED: retry refused'; end if;
  if (select next_attempt_at from public.ai_jobs where correlation_id = jid) <> now() then raise exception 'CHECK FAILED: a retry time in the past was stored raw'; end if;
  if (select status from public.ai_jobs where correlation_id = jid) <> 'retry_wait' then raise exception 'CHECK FAILED: not in retry_wait'; end if;
end $$;

-- 6c. Job key: an unambiguous encoding of (provider, mailbox, source id); the correlation id is its hash.
do $$ declare a text; b text; c text; ka text; kb text; begin
  a := public.ai_enqueue_job('synthetic', 'a|b', 'c');
  b := public.ai_enqueue_job('synthetic', 'a', 'b|c');
  if a = b then raise exception 'CHECK FAILED: two different references became one job (ambiguous job key)'; end if;
  select job_key into ka from public.ai_jobs where correlation_id = a;
  select job_key into kb from public.ai_jobs where correlation_id = b;
  if ka <> '["synthetic","a|b","c"]' or kb <> '["synthetic","a","b|c"]' then raise exception 'CHECK FAILED: job key is not the canonical JSON array: % / %', ka, kb; end if;
  -- the same value the application computes: jobId = first 12 hex of sha256(jobKey)
  if (select correlation_id from public.ai_jobs where correlation_id = a) <> substr(encode(sha256(convert_to(ka, 'utf8')), 'hex'), 1, 12) then
    raise exception 'CHECK FAILED: correlation id is not the hash of the job key'; end if;
  c := public.ai_enqueue_job('synthetic', 'a|b', 'c');
  if c <> a then raise exception 'CHECK FAILED: the same reference is no longer the same job'; end if;
  -- characters that need JSON escaping stay unambiguous
  a := public.ai_enqueue_job('synthetic', 'q"uote', E'back\\slash');
  select job_key into ka from public.ai_jobs where correlation_id = a;
  if ka <> E'["synthetic","q\\"uote","back\\\\slash"]' then raise exception 'CHECK FAILED: escaping in job key: %', ka; end if;
end $$;
-- Reference limits and basic validity (the table also enforces them, so a direct insert cannot get around the function).
select pg_temp.expect_error($q$ select public.ai_enqueue_job('synthetic', repeat('m', 201), 'x') $q$, '23514');
select pg_temp.expect_error($q$ select public.ai_enqueue_job('synthetic', 'box', '') $q$, '23514');
select pg_temp.expect_error($q$ select public.ai_enqueue_job('synthetic', 'box', repeat('s', 513)) $q$, '23514');
select pg_temp.expect_error($q$ select public.ai_enqueue_job('synthetic', 'box', null) $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_enqueue_job('synthetic', null, 'x') $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_enqueue_job(null, 'box', 'x') $q$, '22023');
select pg_temp.expect_error($q$ select public.ai_enqueue_job('imap', 'box', 'x') $q$, '23514');
select pg_temp.expect_error($q$ select public.ai_enqueue_job('synthetic', 'box', 'x', 0) $q$, '23514');
select pg_temp.expect_error($q$ select public.ai_enqueue_job('synthetic', 'box', 'x', 11) $q$, '23514');
do $$ begin
  if public.ai_enqueue_job('synthetic', repeat('m', 200), repeat('s', 512)) is null then raise exception 'CHECK FAILED: maximum-length reference refused'; end if;
end $$;
-- service_role reads ai_jobs but cannot write it, delete from it or truncate it (and cannot delete or truncate ai_messages).
select pg_temp.expect_error($q$ update public.ai_jobs set status = 'completed' $q$, '42501');
select pg_temp.expect_error($q$ update public.ai_jobs set lease_expires_at = now() + interval '100 years' $q$, '42501');
select pg_temp.expect_error($q$ insert into public.ai_jobs (job_key, correlation_id, provider, mailbox_ref, source_message_id) values ('x','x','synthetic','b','s') $q$, '42501');
select pg_temp.expect_error($q$ delete from public.ai_jobs $q$, '42501');
select pg_temp.expect_error($q$ truncate public.ai_jobs $q$, '42501');
select pg_temp.expect_error($q$ delete from public.ai_messages $q$, '42501');
select pg_temp.expect_error($q$ truncate public.ai_messages $q$, '42501');
do $$ begin
  if (select count(*) from public.ai_jobs) < 5 then raise exception 'CHECK FAILED: service_role cannot read ai_jobs'; end if;
end $$;
select pg_temp.reset_role();

-- 6d. An administrator can put a FAILED job back in the queue, and only that; the reviewer is recorded.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$ declare jid text; begin
  select correlation_id into jid from public.ai_jobs where source_message_id = 'job-1';
  if (select status from public.ai_jobs where correlation_id = jid) <> 'failed' then raise exception 'CHECK FAILED: fixture job-1 is not failed'; end if;
  if public.ai_requeue_job(jid) is not true then raise exception 'CHECK FAILED: a failed job could not be retried'; end if;
  if (select status || attempts::text from public.ai_jobs where correlation_id = jid) <> 'queued0' or (select requeued_by from public.ai_jobs where correlation_id = jid) <> '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'CHECK FAILED: requeue did not reset the job and record the administrator'; end if;
  if public.ai_requeue_job(jid) is not false then raise exception 'CHECK FAILED: a job that is not failed was requeued'; end if;
  if public.ai_requeue_job('0123456789ab') is not false then raise exception 'CHECK FAILED: requeue of an unknown job did not return false'; end if;
end $$;
select pg_temp.reset_role();
-- Owner: make a second job FAILED (the job-ID contract below needs a failed job to try to requeue).
update public.ai_jobs set status = 'failed', error_category = 'internal_error', lease_owner = null, lease_expires_at = null, finished_at = now() where source_message_id = 'job-same-owner';
-- THE JOB-ID CONTRACT: the public id is the 12-hex correlation id. The internal row uuid is not a handle, in any spelling.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$ declare jid text; internal uuid; begin
  select correlation_id, id into jid, internal from public.ai_jobs where source_message_id = 'job-same-owner';
  if public.ai_requeue_job(internal::text) is not false then raise exception 'CHECK FAILED: the internal row uuid worked as a job id'; end if;
  if public.ai_requeue_job(upper(jid)) is not false then raise exception 'CHECK FAILED: an upper-case job id matched'; end if;
  if public.ai_requeue_job(jid) is not true then raise exception 'CHECK FAILED: the public job id did not work'; end if;
end $$;
select pg_temp.reset_role();
-- The public id is a 12-hex string, unique (the table refuses anything else, even from its owner).
select pg_temp.expect_error($q$ insert into public.ai_jobs (job_key, correlation_id, provider, mailbox_ref, source_message_id) values ('k-bad-1','NOTHEX123456','synthetic','b','s1') $q$, '23514');
select pg_temp.expect_error($q$ insert into public.ai_jobs (job_key, correlation_id, provider, mailbox_ref, source_message_id) values ('k-bad-2','0123456789abc','synthetic','b','s2') $q$, '23514');
select pg_temp.expect_error($q$ insert into public.ai_jobs (job_key, correlation_id, provider, mailbox_ref, source_message_id)
  select 'k-dup', correlation_id, 'synthetic', 'b', 's3' from public.ai_jobs limit 1 $q$, '23505');
select pg_temp.act_as_service();
do $$ declare v text; begin
  -- enqueue returns exactly the public id, and it is the hash the application computes
  v := public.ai_enqueue_job('synthetic', 'box', 'contract-1');
  if not exists (select 1 from public.ai_jobs where correlation_id = v
                  and correlation_id = substr(encode(sha256(convert_to(job_key, 'utf8')), 'hex'), 1, 12)) then
    raise exception 'CHECK FAILED: ai_enqueue_job did not return the public job id'; end if;
end $$;
select pg_temp.reset_role();

-- 7. Last administrator (L-6). 'a1' is the only admin here. Trusted paths (the SQL editor, the service role) get NO bypass, and
-- deleting the auth user is refused too: the delete cascades to the profile row and the row trigger fires for cascaded rows.
-- (23514 = check_violation, raised by profiles_keep_an_admin().)
select pg_temp.expect_error($q$ update public.profiles set role = 'member' where id = '00000000-0000-0000-0000-0000000000a1' $q$, '23514');
select pg_temp.expect_error($q$ delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a1' $q$, '23514');
select pg_temp.expect_error($q$ delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1' $q$, '23514');
do $$ begin
  if (select count(*) from public.profiles where role = 'admin') <> 1
     or not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'CHECK FAILED: the last administrator was removed'; end if;
  update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000b2';    -- a second administrator
  update public.profiles set role = 'member' where id = '00000000-0000-0000-0000-0000000000a1';   -- now demoting the first is fine
  if (select count(*) from public.profiles where role = 'admin') <> 1 then raise exception 'CHECK FAILED: demotion with a second admin present'; end if;
end $$;
select pg_temp.expect_error($q$ update public.profiles set role = 'member' where id = '00000000-0000-0000-0000-0000000000b2' $q$, '23514');
select pg_temp.act_as_service();
select pg_temp.expect_error($q$ update public.profiles set role = 'member' where role = 'admin' $q$, '23514');
select pg_temp.reset_role();

-- 8. No API role (and not PUBLIC) can EXECUTE a trigger function: they are not endpoints. Needs no JWT; checks the catalog.
do $$ declare f text; r text; begin
  foreach f in array array['handle_new_user', 'guard_profile_update', 'profiles_keep_an_admin', 'tasks_log_activity',
                           'tasks_before_write', 'touch_updated_at', 'tasks_guard', 'integrations_guard'] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, 'public.' || f || '()', 'EXECUTE') then
        raise exception 'CHECK FAILED: % can EXECUTE the trigger function %()', r, f; end if;
    end loop;
  end loop;
end $$;

-- 9. EXACT table privileges, from the catalog (needs no JWT). The expected sets are exactly what the application and worker need.
-- Column-level grants are counted too: a column grant is another way around a table-level revoke. PUBLIC (grantee 0) gets nothing.
do $$ declare t text; r text; p text; want text[]; begin
  foreach t in array array['ai_messages', 'ai_jobs'] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      want := case
        when t = 'ai_messages' and r = 'authenticated' then array['SELECT']
        when t = 'ai_messages' and r = 'service_role' then array['SELECT', 'INSERT', 'UPDATE']
        when t = 'ai_jobs' and r in ('authenticated', 'service_role') then array['SELECT']
        else array[]::text[] end;
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, 'public.' || t, p) <> (p = any (want)) then
          raise exception 'CHECK FAILED: % % on public.%: expected %, found %', r, p, t, (p = any (want)), has_table_privilege(r, 'public.' || t, p); end if;
      end loop;
      foreach p in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
        if has_any_column_privilege(r, 'public.' || t, p) <> (p = any (want)) then
          raise exception 'CHECK FAILED: % has a column-level % grant on public.%', r, p, t; end if;
      end loop;
    end loop;
    if exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid = ('public.' || t)::regclass and a.grantee = 0) then
      raise exception 'CHECK FAILED: PUBLIC holds a privilege on public.%', t; end if;
  end loop;
end $$;

-- 10. EXACT function EXECUTE rights: worker functions for service_role only, reviewer functions for signed-in users only, nobody else.
do $$ declare f record; r text; begin
  for f in select * from (values
      ('public.ai_record_audit_event(text,text,text,uuid,uuid,jsonb)', 'service_role'),
      ('public.ai_approve_message(uuid,text,text,uuid,timestamptz,text)', 'authenticated'),
      ('public.ai_reject_message(uuid)', 'authenticated'),
      ('public.ai_enqueue_job(text,text,text,integer)', 'service_role'),
      ('public.ai_claim_job(text,integer)', 'service_role'),
      ('public.ai_complete_job(text,text,integer,text,text,boolean)', 'service_role'),
      ('public.ai_retry_job(text,text,integer,text,timestamptz,text,boolean)', 'service_role'),
      ('public.ai_fail_job(text,text,integer,text,text,boolean)', 'service_role'),
      ('public.ai_requeue_job(text)', 'authenticated')) as v (sig, only_role)
  loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f.sig, 'EXECUTE') <> (r = f.only_role) then
        raise exception 'CHECK FAILED: EXECUTE on % for %: expected %', f.sig, r, (r = f.only_role); end if;
    end loop;
    -- PUBLIC: functions are executable by everyone unless the ACL was rewritten, so require a non-null ACL with no PUBLIC entry.
    if (select proacl from pg_proc where oid = f.sig::regprocedure) is null
       or exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = f.sig::regprocedure and a.grantee = 0) then
      raise exception 'CHECK FAILED: PUBLIC can EXECUTE %', f.sig; end if;
  end loop;
end $$;

-- 11. The opaque review id: unique, never null, filled in by the database when not supplied.
do $$ begin
  insert into public.ai_messages (dedupe_key, workflow_id, provider, source_message_id, mailbox_ref, received_at, sender_email, subject,
                                  status, owner, risk_flags, classifier)
  values ('test|synthetic|k3', 'eeeeeeeeeeee', 'synthetic', 'syn-3', 'box', now(), 'sender3@example.test', 'Synthetic subject 3',
          'REVIEW_REQUIRED', '{"user_id": null, "rule_id": null, "reason": "test"}', '{}', '{"mode":"rules","fallback_reason":null}');
  if (select review_id from public.ai_messages where dedupe_key = 'test|synthetic|k3') is null then raise exception 'CHECK FAILED: no default review_id'; end if;
  if (select count(distinct review_id) from public.ai_messages) <> 3 then raise exception 'CHECK FAILED: review ids are not distinct'; end if;
end $$;
select pg_temp.expect_error($q$ insert into public.ai_messages (review_id, dedupe_key, workflow_id, provider, source_message_id, mailbox_ref, received_at, sender_email, subject,
                                  status, owner, risk_flags, classifier)
  values ('11111111-1111-4111-8111-111111111111', 'test|synthetic|k4', 'ffffffffffff', 'synthetic', 'syn-4', 'box', now(), 's4@example.test', 'x',
          'REVIEW_REQUIRED', '{"user_id": null, "rule_id": null, "reason": "test"}', '{}', '{"mode":"rules","fallback_reason":null}') $q$, '23505');
select pg_temp.expect_error($q$ update public.ai_messages set review_id = null where dedupe_key = 'test|synthetic|k3' $q$, '23502');

do $$ begin raise notice 'ALL CHECKS PASSED (single-session checks only; run the two-session procedure below as well)'; end $$;
rollback;   -- leave nothing behind

-- ----------------------------------------------------------------------------------------------------------
-- MANUAL TWO-SESSION CHECKS (cannot be done in one script)
--  Concurrent claim: enqueue two jobs. Session A: begin; select * from public.ai_claim_job('a', 60);  (leave open)
--    Session B: select * from public.ai_claim_job('b', 60);  -> must return the OTHER job, never A's (SKIP LOCKED).
--  Concurrent approval: Session A (as an administrator): begin; select public.ai_approve_message(<review_id>, ...);  (leave open)
--    Session B (same administrator): select public.ai_approve_message(<review_id>, ...);  -> must WAIT, then fail with 55000 after A commits.
--    Afterwards exactly one task and one approval event exist.
-- ----------------------------------------------------------------------------------------------------------
