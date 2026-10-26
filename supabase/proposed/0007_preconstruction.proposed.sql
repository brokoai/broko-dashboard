-- ============================================================================================
-- PROPOSED, NOT APPLIED. Pre-Construction Advisor (Phase 1): projects, project documents, extracted text chunks (Postgres
-- full-text search), GTA inventory, an audit trail and a private storage bucket.
-- Depends on 0001 (public.profiles, public.is_admin(), public.touch_updated_at()). Additive only: no drops, no data changes.
-- Verified only on a local PostgreSQL (supabase/proposed/tests/0007_preconstruction.pglite.mjs). NOT verified against a real
-- Supabase project, PostgREST or Storage. The storage section in particular needs a check on the dev project (see the end).
--
-- WHO CAN DO WHAT (conservative; the business rule is "administrators manage, everyone signed in reads"):
--   read   : every signed-in user reads ACTIVE projects and their documents, text chunks and inventory (the shared knowledge
--            base). Archived projects are visible to administrators only.
--   write  : administrators only (create/edit/archive projects, upload/remove documents, import/edit inventory).
--   unit_number : the one restricted inventory column. Members cannot SELECT it (column privilege); administrators read it
--            through public.precon_unit_numbers(). RLS filters rows, not columns, so this needs a privilege (as in 0006).
--   audit  : administrators read the trail; nobody can update or delete it.
-- Nothing is deleted through the API for projects (archive instead). Documents can be removed by administrators; their chunks
-- are removed with them by the foreign key (no orphaned text).
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
-- On the dev project the CLI's login role (cli_login_postgres) is a member of postgres with SET but NOT INHERIT and has no
-- CREATE on schema public, so objects can only be created after SET ROLE postgres (this also makes postgres the owner).
-- The previous role is saved and restored at the end instead of `reset role`: if the CLI had already switched to postgres, a
-- plain `reset role` would drop it back to the login role and the CLI's own migration-history insert, queued after this file,
-- would fail. Saving and restoring is correct whether or not the CLI switched first, and when run in the SQL editor.
select set_config('broko.prev_role', current_user, false);
set role postgres;

-- ------------------------------------------------------------------ projects
create table public.precon_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  developer text check (char_length(developer) <= 200),
  city text check (char_length(city) <= 100),
  address text check (char_length(address) <= 300),
  status text not null default 'pre_construction'
    check (status in ('pre_construction', 'selling', 'under_construction', 'completed', 'on_hold')),
  description text check (char_length(description) <= 4000),
  expected_completion date,
  archived_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index precon_projects_name_idx on public.precon_projects (lower(name));
create index precon_projects_active_idx on public.precon_projects (archived_at) where archived_at is null;

-- ----------------------------------------------------------------- documents
-- One row per uploaded file. The row is created BEFORE the upload (status 'pending') and the storage policy below only accepts an
-- object whose path belongs to a pending row, so a storage object can never exist without a row.
create table public.precon_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.precon_projects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  filename text not null check (char_length(filename) between 1 and 200),
  kind text not null default 'document'
    check (kind in ('brochure', 'floor_plan', 'rendering', 'pricing_sheet', 'inventory_sheet', 'document', 'other')),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  storage_path text not null unique check (storage_path ~ '^projects/[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed', 'needs_reprocessing')),
  -- Fixed vocabulary, never raw error text: e.g. unsupported_type, too_large, content_mismatch, extract_failed, empty, no_text.
  status_detail text check (char_length(status_detail) <= 60),
  page_count integer check (page_count >= 0),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  extractor_version integer,
  attempts integer not null default 0,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);
create index precon_documents_project_idx on public.precon_documents (project_id, created_at desc);
-- The same content is accepted once per project (a re-upload of identical bytes is refused by the application with a clear message).
create unique index precon_documents_project_sha_idx on public.precon_documents (project_id, sha256) where sha256 is not null;

-- -------------------------------------------------------------------- chunks
-- Extracted text, split for retrieval. `page` is the PDF page (1-based) when the extractor knows it, otherwise null.
create table public.precon_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.precon_documents (id) on delete cascade,
  project_id uuid not null references public.precon_projects (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  page integer check (page >= 1),
  content text not null check (char_length(content) between 1 and 4000),
  tsv tsvector generated always as (to_tsvector('english'::regconfig, content)) stored,
  unique (document_id, chunk_index)
);
create index precon_chunks_tsv_idx on public.precon_chunks using gin (tsv);
create index precon_chunks_project_idx on public.precon_chunks (project_id);

-- ----------------------------------------------------------------- inventory
create table public.precon_inventory (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.precon_projects (id) on delete cascade,
  unit_number text check (char_length(unit_number) between 1 and 40),   -- restricted column: see header
  unit_type text check (char_length(unit_type) <= 80),
  bedrooms smallint check (bedrooms between 0 and 10),                  -- 0 = studio
  den boolean not null default false,
  bathrooms numeric(3, 1) check (bathrooms >= 0 and bathrooms <= 10),
  area_sqft numeric(8, 1) check (area_sqft > 0 and area_sqft <= 100000),
  price numeric(12, 2) check (price >= 0),
  currency text not null default 'CAD' check (currency ~ '^[A-Z]{3}$'),
  availability text not null default 'unknown' check (availability in ('available', 'reserved', 'sold', 'unknown')),
  expected_occupancy date,
  source text not null check (char_length(source) between 1 and 200),  -- 'manual' or 'import: <filename>'
  source_document_id uuid references public.precon_documents (id) on delete set null,
  verified_at timestamptz,                                              -- set only when a person confirms the record
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index precon_inventory_project_idx on public.precon_inventory (project_id);
create index precon_inventory_search_idx on public.precon_inventory (availability, bedrooms, price);
-- Duplicate guard: one unit number per project. (Rows without a unit number are de-duplicated by the importer.)
create unique index precon_inventory_unit_idx on public.precon_inventory (project_id, unit_number) where unit_number is not null;

-- --------------------------------------------------------------------- audit
-- Content-free: counts, filenames and ids, never document text or prices.
create table public.precon_audit (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.precon_projects (id) on delete set null,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (char_length(action) between 1 and 60),
  entity text not null check (entity in ('project', 'document', 'inventory')),
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index precon_audit_project_idx on public.precon_audit (project_id, created_at desc);

-- ------------------------------------------------------------------ triggers
create trigger precon_projects_touch before update on public.precon_projects for each row execute function public.touch_updated_at();
create trigger precon_documents_touch before update on public.precon_documents for each row execute function public.touch_updated_at();
create trigger precon_inventory_touch before update on public.precon_inventory for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------- functions
-- Full-text search over the chunks the caller may see. SECURITY INVOKER: row level security below applies, so a member never
-- gets a chunk of an archived project. websearch_to_tsquery never raises on user input.
create function public.precon_search_chunks(q text, p_project uuid default null, lim integer default 8)
returns table (chunk_id uuid, document_id uuid, project_id uuid, page integer, content text, rank real)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.document_id, c.project_id, c.page, c.content,
         ts_rank_cd(c.tsv, websearch_to_tsquery('english'::regconfig, q))::real
  from public.precon_chunks c
  where c.tsv @@ websearch_to_tsquery('english'::regconfig, q)
    and (p_project is null or c.project_id = p_project)
  order by 6 desc, c.document_id, c.chunk_index
  limit least(greatest(lim, 1), 20);
$$;

-- Unit numbers are administrator-only. Members get an empty result, not an error.
create function public.precon_unit_numbers(p_project uuid default null)
returns table (id uuid, unit_number text)
language sql stable security definer set search_path = '' as $$
  select i.id, i.unit_number
  from public.precon_inventory i
  where public.is_admin() and i.unit_number is not null and (p_project is null or i.project_id = p_project);
$$;

-- --------------------------------------------------------- row level security
alter table public.precon_projects enable row level security;
alter table public.precon_documents enable row level security;
alter table public.precon_chunks enable row level security;
alter table public.precon_inventory enable row level security;
alter table public.precon_audit enable row level security;

create policy precon_projects_read on public.precon_projects for select to authenticated
  using (archived_at is null or public.is_admin());
create policy precon_projects_insert on public.precon_projects for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid());
create policy precon_projects_update on public.precon_projects for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Child rows are visible exactly when their project is (the subquery runs under the projects policy above).
create policy precon_documents_read on public.precon_documents for select to authenticated
  using (exists (select 1 from public.precon_projects p where p.id = project_id));
create policy precon_documents_insert on public.precon_documents for insert to authenticated
  with check (public.is_admin() and uploaded_by = auth.uid() and status = 'pending');
create policy precon_documents_update on public.precon_documents for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy precon_documents_delete on public.precon_documents for delete to authenticated
  using (public.is_admin());

create policy precon_chunks_read on public.precon_chunks for select to authenticated
  using (exists (select 1 from public.precon_projects p where p.id = project_id));
create policy precon_chunks_insert on public.precon_chunks for insert to authenticated
  with check (public.is_admin() and exists (select 1 from public.precon_documents d where d.id = document_id and d.project_id = precon_chunks.project_id));
create policy precon_chunks_delete on public.precon_chunks for delete to authenticated
  using (public.is_admin());

create policy precon_inventory_read on public.precon_inventory for select to authenticated
  using (exists (select 1 from public.precon_projects p where p.id = project_id));
create policy precon_inventory_insert on public.precon_inventory for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid());
create policy precon_inventory_update on public.precon_inventory for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy precon_audit_read on public.precon_audit for select to authenticated using (public.is_admin());
create policy precon_audit_insert on public.precon_audit for insert to authenticated
  with check (public.is_admin() and actor_id = auth.uid());

-- ---------------------------------------------------------------- privileges
-- Supabase auto-grants every privilege on new public tables to anon/authenticated/service_role (including TRUNCATE, which RLS
-- does not stop). Revoke everything, then grant back only what the app needs. Nothing goes to anon.
revoke all on public.precon_projects, public.precon_documents, public.precon_chunks, public.precon_inventory, public.precon_audit
  from public, anon, authenticated, service_role;

grant select on public.precon_projects to authenticated;
grant insert (name, developer, city, address, status, description, expected_completion, created_by) on public.precon_projects to authenticated;
grant update (name, developer, city, address, status, description, expected_completion, archived_at) on public.precon_projects to authenticated;

grant select on public.precon_documents to authenticated;
grant insert (id, project_id, title, filename, kind, mime_type, size_bytes, storage_path, uploaded_by) on public.precon_documents to authenticated;
grant update (title, kind, sha256, status, status_detail, page_count, chunk_count, extractor_version, attempts, processed_at) on public.precon_documents to authenticated;
grant delete on public.precon_documents to authenticated;

grant select on public.precon_chunks to authenticated;
grant insert (document_id, project_id, chunk_index, page, content) on public.precon_chunks to authenticated;
grant delete on public.precon_chunks to authenticated;

-- Every column EXCEPT unit_number.
grant select (id, project_id, unit_type, bedrooms, den, bathrooms, area_sqft, price, currency, availability, expected_occupancy,
              source, source_document_id, verified_at, created_by, created_at, updated_at) on public.precon_inventory to authenticated;
grant insert (project_id, unit_number, unit_type, bedrooms, den, bathrooms, area_sqft, price, currency, availability, expected_occupancy,
              source, source_document_id, verified_at, created_by) on public.precon_inventory to authenticated;
grant update (unit_type, bedrooms, den, bathrooms, area_sqft, price, currency, availability, expected_occupancy,
              source, source_document_id, verified_at) on public.precon_inventory to authenticated;

grant select on public.precon_audit to authenticated;
grant insert (project_id, actor_id, action, entity, entity_id, detail) on public.precon_audit to authenticated;

revoke all on function public.precon_search_chunks(text, uuid, integer) from public, anon, service_role;
grant execute on function public.precon_search_chunks(text, uuid, integer) to authenticated;
revoke all on function public.precon_unit_numbers(uuid) from public, anon, service_role;
grant execute on function public.precon_unit_numbers(uuid) to authenticated;

-- ------------------------------------------------------------------- storage
-- Private bucket: no public URL ever exists; the app issues short-lived signed URLs after checking access.
-- The bucket itself also enforces the size ceiling and the allowed content types (the application checks both again, by content).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (
  'precon-files', 'precon-files', false, 26214400,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

-- Read: only an object that belongs to a document row the caller can see (so an archived project's files stay hidden from members).
create policy precon_files_read on storage.objects for select to authenticated
  using (bucket_id = 'precon-files' and exists (select 1 from public.precon_documents d where d.storage_path = name));
-- Upload: administrators only, and only to the path of a document row that is still pending (no stray objects).
create policy precon_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'precon-files' and public.is_admin()
    and exists (select 1 from public.precon_documents d where d.storage_path = name and d.status = 'pending'));
create policy precon_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'precon-files' and public.is_admin());

-- ROLLBACK (manual, on an empty or disposable database only; it destroys data):
--   drop policy precon_files_read on storage.objects; drop policy precon_files_insert on storage.objects; drop policy precon_files_delete on storage.objects;
--   drop function public.precon_search_chunks(text, uuid, integer); drop function public.precon_unit_numbers(uuid);
--   drop table public.precon_audit, public.precon_inventory, public.precon_chunks, public.precon_documents, public.precon_projects;
--   (and remove the 'precon-files' bucket and its objects through the Storage API, never with SQL.)
--
-- STILL TO VERIFY ON THE DEV PROJECT BEFORE ANY REAL DATA (a local PostgreSQL cannot show these):
--   1. `postgres` may create policies on storage.objects in a migration (it normally can; the statement above is standard).
--   2. createSignedUploadUrl / createSignedUrl behave as assumed under these policies, as an administrator and as a member.
--   3. The bucket's allowed_mime_types / file_size_limit reject a wrong type / oversized upload.
--   4. Run supabase/proposed/tests/0007_preconstruction.pglite.mjs' assertions as read-only SQL on the dev project.

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
