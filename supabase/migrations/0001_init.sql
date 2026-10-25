-- Broko AI Operations Dashboard: Phase 1 foundation.
-- !! NOT APPLIED to any remote database. Verified only on a local PostgreSQL (PGlite) that imitates Supabase's roles and
-- !! default privileges (supabase/proposed/tests/). NOT verified against real Supabase, PostgREST or GoTrue.
-- !! Do NOT run against an existing database: it assumes an empty one (generic table names, Supabase auth schema).
-- !! Apply together with supabase/proposed/0002_hardening.proposed.sql: on its own this file leaves task reassignment (H-1)
-- !! enforced only by the application. Findings: docs/SUPABASE_SECURITY_STATUS.md.
-- Additive only (no drops).
--
-- LEAST-PRIVILEGE REVISION (reviewed against the dev project's actual defaults and run on a local PostgreSQL):
--  * Supabase grants anon / authenticated / service_role EVERY privilege (incl. TRUNCATE) on every new public table and
--    EXECUTE on every new function (pg_default_acl). RLS does not stop TRUNCATE. This file therefore REVOKES everything it
--    creates from those roles and grants back only what the app and its workers need (see the PRIVILEGES section).
--  * Objects are created by role `postgres`, not by the CLI's temporary login role, so SECURITY DEFINER functions have a
--    permanent owner (see `set role` below).
--  * SECURITY DEFINER functions pin search_path to '' and use fully qualified names.

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
-- On the dev project the CLI's login role (cli_login_postgres) is a member of postgres with SET but NOT INHERIT and has no
-- CREATE on schema public, so objects can only be created after SET ROLE postgres (this also makes postgres the owner).
-- The previous role is saved and restored at the end instead of `reset role`: if the CLI had already switched to postgres, a
-- plain `reset role` would drop it back to the login role and the CLI's own migration-history insert, queued after this file,
-- would fail. Saving and restoring is correct whether or not the CLI switched first, and when run in the SQL editor.
select set_config('broko.prev_role', current_user, false);
set role postgres;

-- (No extensions: gen_random_uuid() and sha256() are built into PostgreSQL 13+; the project runs 17. Creating pgcrypto here
-- could place its functions in `public`, where Supabase's default privileges would expose them as API endpoints.)

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text,
  role text not null default 'member' check (role in ('admin', 'member')),
  title text,                         -- display title, e.g. 'Founder & CEO'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- tasks
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  description text,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'completed', 'cancelled')),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  assigned_to uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  due_at timestamptz,
  source text not null default 'manual',   -- manual | email | teams | ai ...
  external_reference text,                 -- e.g. Notion page id (later)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index tasks_assigned_to_idx on public.tasks (assigned_to);
create index tasks_created_by_idx on public.tasks (created_by);
create index tasks_status_due_idx on public.tasks (status, due_at);

-- --------------------------------------------------------- activity_events
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'email_received', 'message_classified', 'potential_task_identified',
    'task_created', 'task_assigned', 'task_updated', 'task_completed',
    'notification_sent', 'workflow_failed')),
  description text not null,
  status text not null default 'processed'
    check (status in ('processed', 'pending', 'failed')),
  actor_id uuid references public.profiles (id) on delete set null,
  related_task_id uuid references public.tasks (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index activity_events_created_idx on public.activity_events (created_at desc);
create index activity_events_task_idx on public.activity_events (related_task_id);

-- ----------------------------------------------------------- notifications
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  body text,
  related_task_id uuid references public.tasks (id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- ------------------------------------------------------------ integrations
-- Status only. OAuth tokens/secrets must NEVER be stored in this table.
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in (
    'microsoft_outlook', 'microsoft_teams', 'microsoft_calendar', 'onedrive',
    'gmail', 'google_calendar', 'whatsapp_business')),
  status text not null default 'pending_setup'
    check (status in ('connected', 'disconnected', 'pending_setup', 'error')),
  connected_by uuid references public.profiles (id) on delete set null,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.integrations (provider) values
  ('microsoft_outlook'), ('microsoft_teams'), ('microsoft_calendar'),
  ('onedrive'), ('gmail'), ('google_calendar'), ('whatsapp_business');

-- ---------------------------------------------------------------- helpers
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger integrations_touch before update on public.integrations
  for each row execute function public.touch_updated_at();

-- New auth user -> profile (always 'member'; promote admins manually).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stop non-admins changing role/title (privilege escalation guard).
create function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- auth.uid() is null for trusted maintenance (SQL editor, service role): the first admin must be promotable.
  -- Browser sessions always carry a user id, and authenticated has no UPDATE privilege on these columns anyway.
  if auth.uid() is not null and not public.is_admin() and (new.role is distinct from old.role
      or new.title is distinct from old.title) then
    raise exception 'only administrators can change role or title';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Never leave the project without an administrator (L-6). Unlike guard_profile_update this has NO trusted-path bypass: the
-- service role and the SQL editor are refused too, and so is the cascade from deleting an auth user (row triggers fire for
-- cascaded deletes, so removing the last admin's login is blocked at the database). To remove or demote the last
-- administrator on purpose, promote someone else first. Not covered: TRUNCATE (nobody has it), disabling the trigger, and
-- session_replication_role = replica (owner / superuser actions, outside the API).
create function public.profiles_keep_an_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role is distinct from 'admin') then
    -- Lock the OTHER administrators while checking, so two concurrent removals cannot both pass (one waits; a deadlock aborts one).
    perform 1 from public.profiles where role = 'admin' and id <> old.id for update;
    if not found then
      raise exception 'cannot remove or demote the last administrator' using errcode = '23514';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger profiles_keep_an_admin_upd before update of role on public.profiles
  for each row execute function public.profiles_keep_an_admin();
create trigger profiles_keep_an_admin_del before delete on public.profiles
  for each row execute function public.profiles_keep_an_admin();

-- Task timestamps + real activity events written from real task changes.
create function public.tasks_before_write() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then
    new.completed_at = now();
  elsif new.status <> 'completed' then
    new.completed_at = null;
  end if;
  return new;
end $$;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

create function public.tasks_log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity_events (event_type, description, actor_id, related_task_id)
    values ('task_created', 'Task created: ' || new.title, new.created_by, new.id);
    if new.assigned_to is not null then
      insert into public.activity_events (event_type, description, actor_id, related_task_id)
      values ('task_assigned', 'Task assigned: ' || new.title, new.created_by, new.id);
    end if;
  else
    if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then
      insert into public.activity_events (event_type, description, actor_id, related_task_id)
      values ('task_assigned', 'Task assigned: ' || new.title, auth.uid(), new.id);
      insert into public.notifications (user_id, title, related_task_id)
      values (new.assigned_to, 'Task assigned to you: ' || new.title, new.id);
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
create trigger tasks_log after insert or update on public.tasks
  for each row execute function public.tasks_log_activity();

-- Aggregate-only workload so members see team load without seeing others' tasks.
create function public.team_workload()
returns table (member_id uuid, full_name text, title text, role text,
               assigned_count bigint, open_count bigint, completed_count bigint)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.title, p.role,
         count(t.id),
         count(t.id) filter (where t.status in ('open', 'in_progress')),
         count(t.id) filter (where t.status = 'completed')
  from public.profiles p
  left join public.tasks t on t.assigned_to = p.id
  where auth.uid() is not null
  group by p.id
  order by p.full_name;
$$;
revoke all on function public.team_workload() from public, anon;
grant execute on function public.team_workload() to authenticated;

-- -------------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.activity_events enable row level security;
alter table public.notifications enable row level security;
alter table public.integrations enable row level security;

-- profiles: any signed-in user can read names/roles (needed for assignee pickers);
-- users update only themselves; role/title guarded by trigger above.
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- tasks: admins see/edit all; members only tasks assigned to or created by them.
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_admin() or assigned_to = auth.uid() or created_by = auth.uid());
create policy tasks_insert on public.tasks for insert to authenticated
  with check (created_by = auth.uid()
    and (public.is_admin() or assigned_to is null or assigned_to = auth.uid()));
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_admin() or assigned_to = auth.uid() or created_by = auth.uid())
  with check (public.is_admin() or assigned_to = auth.uid() or created_by = auth.uid());
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_admin());

-- activity: admins all; members only events they caused or tied to a visible task.
create policy activity_select on public.activity_events for select to authenticated
  using (public.is_admin() or actor_id = auth.uid()
    or exists (select 1 from public.tasks t where t.id = related_task_id));
-- no insert/update/delete policies: only security-definer triggers and the
-- service role (n8n / AI worker, later) write events.

-- notifications: strictly own.
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- integrations: everyone reads status; only admins change it.
create policy integrations_select on public.integrations for select to authenticated using (true);
create policy integrations_update on public.integrations for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================================ PRIVILEGES
-- Everything above was created while Supabase's default privileges were in force (see the header). From here on, no API
-- role keeps anything it does not need. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are never granted to any API role.
--
--   role            what it is                                   what it gets
--   anon            signed-out requests (public anon key)        NOTHING on any table or function in public
--   authenticated   signed-in users (user JWT; RLS applies)      exactly what the dashboard uses (below)
--   service_role    trusted server code (worker, n8n); bypasses RLS   only what workers need; no DELETE, no TRUNCATE
--   postgres        owner (migrations, SECURITY DEFINER bodies)  everything, as owner
--
-- Policies stay as the row-level layer. Where no privilege is granted a policy is inert until a grant is added on purpose
-- (tasks_delete, integrations_update, profiles_update_self).

revoke all on public.profiles, public.tasks, public.activity_events, public.notifications, public.integrations
  from public, anon, authenticated, service_role;

-- profiles: authenticated reads (assignee pickers, own profile). Nobody edits profiles through the API: role/title/email
-- changes happen server-side. (Column-level SELECT cannot hide emails from colleagues without an app change: see M-4.)
grant select on public.profiles to authenticated;
grant select, update on public.profiles to service_role;

-- tasks: the dashboard reads, creates and edits. Column lists keep clients away from source / external_reference /
-- created_at / updated_at / completed_at (server-controlled) and from re-assigning created_by after creation.
-- No DELETE for clients.
grant select on public.tasks to authenticated;
grant insert (title, description, status, priority, assigned_to, created_by, due_at) on public.tasks to authenticated;
grant update (title, description, status, priority, assigned_to, due_at) on public.tasks to authenticated;
grant select, insert, update on public.tasks to service_role;

-- activity_events: clients read only. Events are written by SECURITY DEFINER triggers (owner) and by the service role.
grant select on public.activity_events to authenticated;
grant select, insert on public.activity_events to service_role;

-- notifications: users read their own and may mark them read (read_at only).
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select, insert, update on public.notifications to service_role;

-- integrations: status is READ-ONLY for clients. Only a trusted verification service (service_role) may set it, so a
-- "connected" badge can never be put there by hand through the API.
grant select on public.integrations to authenticated;
grant select, update on public.integrations to service_role;

-- Functions. Trigger functions are never callable through the API. is_admin() is needed by RLS policies for signed-in users.
revoke all on function public.handle_new_user(), public.guard_profile_update(), public.profiles_keep_an_admin(),
  public.tasks_log_activity(), public.tasks_before_write(), public.touch_updated_at()
  from public, anon, authenticated, service_role;
revoke all on function public.is_admin() from public, anon, service_role;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.team_workload() from public, anon, service_role;
grant execute on function public.team_workload() to authenticated;

-- FUTURE objects: Supabase auto-grants every new public object to the API roles. Changing that platform default is a separate,
-- deliberate decision, proposed (and NOT enabled) in supabase/proposed/0005_default_privileges.proposed.sql. Until then every
-- migration, including 0003/0004, revokes explicitly.

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
