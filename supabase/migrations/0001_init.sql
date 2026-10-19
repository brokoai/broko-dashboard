-- Broko AI Operations Dashboard: Phase 1 foundation.
-- !! NOT APPLIED ANYWHERE and NOT VERIFIED against a real database. The backend (AWS /
-- !! Supabase / other) has not been chosen. Do NOT run against an existing database: it assumes
-- !! an empty one (generic table names, Supabase auth schema). Known issues and proposed fixes:
-- !! docs/SECURITY_AND_MIGRATION_REVIEW.md and supabase/proposed/0002_hardening.proposed.sql.
-- Additive only (no drops).

create extension if not exists "pgcrypto";

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
language sql stable security definer set search_path = public as $$
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
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stop non-admins changing role/title (privilege escalation guard).
create function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and (new.role is distinct from old.role
      or new.title is distinct from old.title) then
    raise exception 'only administrators can change role or title';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

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
language plpgsql security definer set search_path = public as $$
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
language sql stable security definer set search_path = public as $$
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
