-- ============================================================================
-- PROPOSED, NOT APPLIED to any remote database. Verified only on a local PostgreSQL (PGlite): see supabase/proposed/tests/.
-- Fixes for the findings in docs/SECURITY_AND_MIGRATION_REVIEW.md and docs/SUPABASE_SECURITY_STATUS.md.
-- Depends on 0001_init.sql and is meant to be applied after it, in the same push: 0001 alone leaves task reassignment (H-1) to the
-- application. 0003 REPLACES tasks_guard created here (see "tasks_guard" in docs/ai-brain/AI_INBOX_READINESS.md), so 0002 is a
-- prerequisite of 0003 and rolling 0002 back is not independent of 0003.
-- These guards are the database-side enforcement of: who may be assigned a task, which task columns are server-controlled,
-- and who may set an integration's connection state. Deliberately outside supabase/migrations/ so no tooling picks it up.
-- ============================================================================

-- M-2 / M-3: profile guard.
-- CORRECTED COMMENT (the previous text described an older 0001). The current 0001 guard_profile_update already lets trusted
-- maintenance paths through (auth.uid() is null: SQL editor, service role, migrations), so promoting the first admin works
-- with 0001 alone. What 0001 does NOT cover is the email column, and what it leaves open is a member editing their own email.
-- This replacement keeps the same bypass and adds the email check. (0001's separate profiles_keep_an_admin trigger has NO
-- bypass and is not touched here.)
-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
-- On the dev project the CLI's login role (cli_login_postgres) is a member of postgres with SET but NOT INHERIT and has no
-- CREATE on schema public, so objects can only be created after SET ROLE postgres (this also makes postgres the owner).
-- The previous role is saved and restored at the end instead of `reset role`: if the CLI had already switched to postgres, a
-- plain `reset role` would drop it back to the login role and the CLI's own migration-history insert, queued after this file,
-- would fail. Saving and restoring is correct whether or not the CLI switched first, and when run in the SQL editor.
select set_config('broko.prev_role', current_user, false);
set role postgres;

create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;  -- SQL editor / service role / migrations
  if not public.is_admin() and (new.role  is distinct from old.role
                             or new.title is distinct from old.title
                             or new.email is distinct from old.email) then
    raise exception 'only administrators can change role, title or email' using errcode = '42501';
  end if;
  return new;
end $$;

-- H-1: task guard. 0001 lets a member who may edit a task reassign it to anyone (UPDATE policy
-- checks visibility only), and lets any client set created_by/source/external_reference.
create function public.tasks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;   -- trusted service / maintenance
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.source := 'manual';
    new.external_reference := null;
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
create trigger tasks_guard before insert or update on public.tasks
  for each row execute function public.tasks_guard();

-- H-2: an admin (or anyone) must not be able to mark an integration "connected" by hand.
-- Only a trusted verification service (auth.uid() is null: service role) may do that.
create function public.integrations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.status in ('connected', 'error') and new.status is distinct from old.status)
     or new.last_sync_at  is distinct from old.last_sync_at
     or new.last_error    is distinct from old.last_error
     or new.connected_by  is distinct from old.connected_by then
    raise exception 'integration connection state is set by the verification service only'
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger integrations_guard before update on public.integrations
  for each row execute function public.integrations_guard();

-- L-1: notify the assignee when a task is CREATED already assigned to someone else
-- (0001 only notifies on reassignment). Same function as 0001 plus the INSERT notification.
create or replace function public.tasks_log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity_events (event_type, description, actor_id, related_task_id)
    values ('task_created', 'Task created: ' || new.title, new.created_by, new.id);
    if new.assigned_to is not null then
      insert into public.activity_events (event_type, description, actor_id, related_task_id)
      values ('task_assigned', 'Task assigned: ' || new.title, new.created_by, new.id);
      if new.assigned_to is distinct from new.created_by then
        insert into public.notifications (user_id, title, related_task_id)
        values (new.assigned_to, 'Task assigned to you: ' || new.title, new.id);
      end if;
    end if;
  else
    if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then
      insert into public.activity_events (event_type, description, actor_id, related_task_id)
      values ('task_assigned', 'Task assigned: ' || new.title, auth.uid(), new.id);
      if new.assigned_to is distinct from auth.uid() then
        insert into public.notifications (user_id, title, related_task_id)
        values (new.assigned_to, 'Task assigned to you: ' || new.title, new.id);
      end if;
    end if;
    if new.status is distinct from old.status then
      insert into public.activity_events (event_type, description, actor_id, related_task_id)
      values (case when new.status = 'completed' then 'task_completed' else 'task_updated' end,
              'Task "' || new.title || '" status: ' || old.status || ' -> ' || new.status,
              auth.uid(), new.id);
    end if;
  end if;
  return null;
end $$;

-- L-2: users may only mark their own notifications read, not rewrite them.
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- L-3: do not expose internal/trigger functions as callable RPC endpoints.
-- The two functions created above (tasks_guard, integrations_guard) were created while Supabase's default privileges were in
-- force, so they also carry EXECUTE for service_role: revoke it from every API role, like 0001 does for its trigger functions.
-- (Trigger functions need no EXECUTE to fire: only the privilege to create the trigger is checked, once.)
-- (is_admin must stay executable by `authenticated`: RLS policies call it.)
revoke execute on function
  public.handle_new_user(), public.guard_profile_update(), public.profiles_keep_an_admin(), public.tasks_log_activity(),
  public.tasks_before_write(), public.touch_updated_at(), public.tasks_guard(),
  public.integrations_guard()
  from public, anon, authenticated, service_role;
revoke execute on function public.is_admin() from public, anon, service_role;

-- L-4: missing index for actor lookups.
create index if not exists activity_events_actor_idx on public.activity_events (actor_id);

-- ---------------------------------------------------------------------------
-- OPTIONAL (needs a code change in src/lib/backend/supabase/repo.ts first; do not apply blindly):
-- M-4: profiles_read in 0001 lets every signed-in user query every colleague's EMAIL directly
-- through the API (the dashboard no longer sends emails to the browser, but the API still
-- allows it). To close it, restrict profiles to self + admin and read names through a view:
--
--   drop policy profiles_read on public.profiles;
--   create policy profiles_read on public.profiles for select to authenticated
--     using (id = auth.uid() or public.is_admin());
--   create view public.people as select id, full_name from public.profiles;
--   revoke all on public.people from public, anon;
--   grant select on public.people to authenticated;
--
-- Then listPeople() must read from `people`, and the task query's `assignee:profiles(...)`
-- embed must be replaced (members could no longer resolve other people's names through
-- `profiles`). Decide together with Broko whether member visibility of colleagues' emails matters.
-- ---------------------------------------------------------------------------

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
