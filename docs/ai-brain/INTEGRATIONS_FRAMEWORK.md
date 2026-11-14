# Connection framework (multi-user integrations): Phase A

Status: **Phase A implemented behind a flag (default off). Nothing else is built.** No OAuth app, no credential, no callback, no migration,
no Supabase write, no provider call. Phases B onward need owner approval (see the end).

## 1. What Phase A is

A per-employee **authorization layer** between the Brain and any external provider. Today the Brain gets ONE Notion connector built from a
shared environment token. With `BROKO_CONNECTION_FRAMEWORK=1` it gets a connector assembled **for the signed-in employee** from the
connections that employee may use, and every record is checked against the grant that produced it before it is returned.

Four things are kept apart: (A) the provider grant (a token), (B) what the grant reaches (the provider's own picker/scopes),
(C) which Broko employee may receive answers derived from it, (D) what the organization chose to share. **Reach (B) is never an access rule.**

| Connection | Who may use it | What it can expose |
|---|---|---|
| `personal` | its owner only (an administrator cannot use it either) | whatever the owner's grant reaches |
| `organization` | employees admitted by a registered resource's visibility (`org_members` or `admins`) | only the registered resources (a registered page, or a registered database and its rows) |
| legacy shared token (flag) | administrators only | the whole workspace (the one `*` registration, honored only for this connection) |

Fail closed everywhere: no user id, a store that throws, a connection that is not `active`, the wrong provider/capability, an invalid shape
(personal without owner, organization with owner), a missing client, or a record not covered by its grant all end in "nothing is read /
nothing is returned". Grants are resolved on **every call** and never cached, so revocation applies to the next request.

## 2. Code map

| File | Role |
|---|---|
| `src/lib/ai-brain/integrations/types.ts` | `ConnectionRef` (no secret field), `RegisteredResource`, `ConnectionStore`, `ClientFactory`, `IntegrationRuntime`, `Grant`, and the declared provider/OAuth contract (types only) |
| `integrations/authorize.ts` | pure rules: `grantFor`, `grantAllows`, owner check, visibility, `*` only for legacy |
| `integrations/resolver.ts` | `resolveGrants`: store lookup, per-connection grant, personal first |
| `integrations/scoped-notion.ts` | `scopedNotionConnector(runtime, user)`: a `NotionConnector` that enforces the grants and drops anything not covered |
| `integrations/legacy.ts` | the two flags and the legacy shared token as an admin-only organization connection (`defaultRuntime`) |
| `assistant/brain-tools.ts` | `connectorsFor`: the only wiring change (flag on: use the scoped connector; flag off: unchanged) |
| `assistant/connectors.ts`, `meetings/types.ts`, `assistant/notion.ts` | optional `parent_id` on records, candidates and documents (policy only, never shown) |
| `chat/types.ts` | optional `BrainChatContext.integrations` (tests inject fakes; production uses the default runtime) |

Unchanged and reused as is: `BrokoChat -> askBroko -> handleChat -> askBrain`, the deterministic router, `tryPrecon/tryKnowledge/tryMeeting/tryNotion`,
the Tool Registry (`runTool`, role check, input validation, write gate, timeout, sanitising), the Notion client, the whole meeting pipeline
(find, select, read, analysis, validation, fallback), the synthesis budget, the unlock, the metadata-only audit, Knowledge.

## 3. Flags (both default off)

* `BROKO_CONNECTION_FRAMEWORK=1`: per-employee connectors. Until the connect flow exists (Phase B) no personal connection exists, so Notion is
  unavailable unless the legacy flag is also on.
* `BROKO_LEGACY_NOTION_CONNECTION=1` (framework on): offers the shared environment token as ONE organization connection, **administrators only**.

With the framework flag **off**, `connectorsFor` is byte-for-byte what it was (members keep plain "Search Notion" through the shared token).
Turning the framework on therefore *tightens* member access to the legacy token. That is intended, and is a decision for the owner (section 7).

## 4. Known gaps in Phase A (stated, not hidden)

1. No store, no OAuth, no token storage: the only real connection that can exist is the legacy one. Everything else is exercised with fakes.
2. Organization policy covers a registered page, and a registered database with its direct rows. A page nested deeper than one level under a
   registered page is **denied** (fail closed) until it is registered or a later phase resolves ancestry.
3. An organization read of an unregistered id still performs the provider read before the result is discarded (nothing is returned).
4. Failure vocabulary is unchanged, so a revoked connection and a never-connected employee both read as "Notion is not connected". Distinct
   "reconnect" wording needs a UI/message phase.
5. The meeting tools remain `requires: "admin"`. Lifting that for owners of personal connections is Phase F, after the real two-user test.
6. The Notion client is still on API `2022-06-28` (no data sources). Needed before OAuth tokens are used (Phase D).
7. Provider `parent_id` for a record is whatever Notion reports; for a page inside a synced block or a teamspace root it may be absent, which means "not covered".

## 5. Corrected database schema DRAFT (NOT a migration, NOT in `supabase/`, NOT applied)

Corrections to my earlier proposal, with the reason:

1. **Partial unique index.** The earlier `unique (...) where ...` inside `create table` is not valid SQL (a table constraint cannot carry `WHERE`).
   It also used one index for both kinds: organization rows have a NULL `owner_id`, and NULLs are distinct in a unique index, so two
   organization connections to the same workspace would both have been allowed (same for a nullable workspace id). Fixed with **two
   separate `create unique index ... where` statements**, `provider_workspace_id NOT NULL`, and a CHECK tying `kind` to `owner_id`.
2. **Credential functions.** The earlier plan had `SECURITY DEFINER` functions "for the caller's own connection" returning ciphertext. In this app the
   server talks to Postgres with the **user's own JWT** (anon key, no service role), so anything the server may call, the browser may call
   with the same JWT. Such a function would hand ciphertext to the browser and to anyone holding a stolen session. Fixed: the credential
   table and every credential/OAuth-state function are **executable only by `service_role`** (revoked from `public`, `anon`,
   `authenticated`), used from one server-only module. This introduces a service-role key into the app (decision 3 below).
3. **Single-flight refresh.** "Row-locked refresh inside a function" is impossible: a function cannot hold a lock across the provider's HTTP
   call. Notion rotates BOTH tokens on refresh, so two racing refreshes would make the loser fail and be wrongly marked `needs_reauth`.
   Fixed with a **lease** (`refresh_lease_until`) plus a **compare-and-swap** on `refresh_count`.
4. **Wildcard.** `*` can never be stored (CHECK), so a whole-workspace grant cannot be created by a database row; it exists only in code for the legacy connection.
5. **Registrations belong to organization connections only**, enforced declaratively with a composite foreign key rather than a trigger.

```sql
-- DRAFT 0013 integration_connections, oauth_states, integration_audit.   Follows 0001: created by postgres, everything revoked first,
-- granted back minimally, SECURITY DEFINER pins search_path = '' and uses qualified names.

create table public.integration_connections (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null check (provider in ('notion','outlook_mail','outlook_calendar','teams')),
  kind                    text not null check (kind in ('personal','organization')),
  owner_id                uuid references public.profiles(id) on delete cascade,        -- personal: the employee. organization: NULL.
  created_by              uuid references public.profiles(id) on delete set null,
  provider_workspace_id   text not null check (length(provider_workspace_id) between 1 and 200),
  provider_workspace_name text check (length(provider_workspace_name) <= 200),
  provider_user_id        text check (length(provider_user_id) <= 200),
  status                  text not null default 'active' check (status in ('active','needs_reauth','revoked','disconnected','error')),
  capabilities            text[] not null default '{}',
  connected_at            timestamptz not null default now(),
  last_verified_at        timestamptz,
  last_used_at            timestamptz,
  revoked_at              timestamptz,
  revoked_reason          text check (revoked_reason in ('user','admin','provider','departure','error')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint connection_owner_matches_kind check ((kind = 'personal' and owner_id is not null) or (kind = 'organization' and owner_id is null)),
  constraint connection_terminal_has_time   check (status not in ('revoked','disconnected') or revoked_at is not null),
  unique (id, kind)                                        -- target of integration_resources' composite foreign key
);
-- "Live" = anything that can still be re-authorised. Terminal rows stay for history and never block a fresh connect.
create unique index integration_connections_one_live_personal
  on public.integration_connections (provider, owner_id, provider_workspace_id)
  where kind = 'personal' and status in ('active','needs_reauth','error');
create unique index integration_connections_one_live_organization
  on public.integration_connections (provider, provider_workspace_id)
  where kind = 'organization' and status in ('active','needs_reauth','error');
create index integration_connections_owner_idx on public.integration_connections (owner_id) where owner_id is not null;
create trigger integration_connections_touch before update on public.integration_connections
  for each row execute function public.touch_updated_at();

alter table public.integration_connections enable row level security;
alter table public.integration_connections force row level security;
revoke all on public.integration_connections from public, anon, authenticated, service_role;
-- Owners see their own rows; administrators see METADATA of all rows. Never the credentials (a different table) and never provider_user_id.
create policy integration_connections_select on public.integration_connections for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_admin()));
grant select (id, provider, kind, owner_id, provider_workspace_name, status, capabilities, connected_at, last_verified_at, revoked_at) on public.integration_connections to authenticated;
grant select, insert, update on public.integration_connections to service_role;   -- the connect/refresh/disconnect server code; no DELETE, no TRUNCATE

create table public.oauth_states (
  state_hash  bytea primary key check (octet_length(state_hash) = 32),   -- sha256 of the random state; the state itself is never stored
  user_id     uuid not null references public.profiles(id) on delete cascade,
  provider    text not null check (provider in ('notion','outlook_mail','outlook_calendar','teams')),
  kind        text not null check (kind in ('personal','organization')),
  return_to   text not null check (return_to ~ '^/[A-Za-z0-9/_-]{0,200}$'),   -- internal path only: no open redirect
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
alter table public.oauth_states enable row level security;
alter table public.oauth_states force row level security;
revoke all on public.oauth_states from public, anon, authenticated, service_role;      -- no policy: unreachable except through the functions below

create function public.oauth_state_consume(p_hash bytea, p_user uuid)
returns table (provider text, kind text, return_to text)
language sql security definer set search_path = '' as $$
  update public.oauth_states s set consumed_at = now()
   where s.state_hash = p_hash and s.user_id = p_user and s.consumed_at is null and s.expires_at > now()
  returning s.provider, s.kind, s.return_to;                   -- single use and bound to the signed-in user, in one atomic statement
$$;
revoke all on function public.oauth_state_consume(bytea, uuid) from public, anon, authenticated, service_role;
grant execute on function public.oauth_state_consume(bytea, uuid) to service_role;

create table public.integration_audit (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor_id      uuid references public.profiles(id) on delete set null,
  connection_id uuid references public.integration_connections(id) on delete set null,
  provider      text not null,
  event         text not null check (event in ('connect_started','connected','connect_denied','refresh_ok','refresh_failed','reauth_required',
                  'disconnected','revoked_by_provider','revoked_by_admin','departure_cleanup','resource_registered','resource_removed','retrieval_denied','retrieval_ok')),
  count         integer check (count >= 0)                       -- how many records, never which or what they said
);
alter table public.integration_audit enable row level security;
alter table public.integration_audit force row level security;
revoke all on public.integration_audit from public, anon, authenticated, service_role;
create policy integration_audit_select on public.integration_audit for select to authenticated using ((select public.is_admin()));
grant select on public.integration_audit to authenticated;
grant select, insert on public.integration_audit to service_role;                  -- append-only: no UPDATE, no DELETE
```

```sql
-- DRAFT 0014 integration_credentials and their functions. EVERYTHING here is service_role only.

create table public.integration_credentials (
  connection_id       uuid primary key references public.integration_connections(id) on delete cascade,
  ciphertext          bytea not null check (octet_length(ciphertext) between 29 and 16384),   -- AES-256-GCM: 12-byte nonce + data + 16-byte tag
  key_version         smallint not null check (key_version > 0),
  refresh_count       integer not null default 0,
  refresh_lease_until timestamptz,
  updated_at          timestamptz not null default now()
);
alter table public.integration_credentials enable row level security;
alter table public.integration_credentials force row level security;
revoke all on public.integration_credentials from public, anon, authenticated, service_role;   -- no policy, no grant: only the functions

create function public.integration_credentials_get(p_connection uuid, p_user uuid)
returns table (ciphertext bytea, key_version smallint, refresh_count integer)
language sql security definer set search_path = '' as $$
  select k.ciphertext, k.key_version, k.refresh_count
    from public.integration_credentials k
    join public.integration_connections c on c.id = k.connection_id
   where k.connection_id = p_connection and c.status = 'active'
     and (c.kind = 'organization' or c.owner_id = p_user);        -- p_user is the SERVER-verified session user, never client input
$$;

create function public.integration_credentials_put(p_connection uuid, p_ciphertext bytea, p_key_version smallint, p_expected_count integer)
returns boolean                                                   -- compare-and-swap: false = someone else refreshed first, re-read
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.integration_credentials (connection_id, ciphertext, key_version, refresh_count)
  values (p_connection, p_ciphertext, p_key_version, 0)
  on conflict (connection_id) do update
    set ciphertext = excluded.ciphertext, key_version = excluded.key_version,
        refresh_count = public.integration_credentials.refresh_count + 1, refresh_lease_until = null, updated_at = now()
    where public.integration_credentials.refresh_count = p_expected_count;
  return found;
end $$;

create function public.integration_credentials_lease(p_connection uuid, p_seconds integer)
returns boolean                                                   -- true = you refresh; false = someone else is, wait and re-read
language sql security definer set search_path = '' as $$
  with l as (
    update public.integration_credentials set refresh_lease_until = now() + make_interval(secs => least(greatest(p_seconds, 5), 60))
     where connection_id = p_connection and (refresh_lease_until is null or refresh_lease_until < now())
    returning 1)
  select exists (select 1 from l);
$$;

create function public.integration_credentials_wipe(p_connection uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.integration_credentials where connection_id = p_connection;       -- disconnect / revoke / departure
$$;

revoke all on function public.integration_credentials_get(uuid, uuid), public.integration_credentials_put(uuid, bytea, smallint, integer),
  public.integration_credentials_lease(uuid, integer), public.integration_credentials_wipe(uuid) from public, anon, authenticated, service_role;
grant execute on function public.integration_credentials_get(uuid, uuid), public.integration_credentials_put(uuid, bytea, smallint, integer),
  public.integration_credentials_lease(uuid, integer), public.integration_credentials_wipe(uuid) to service_role;
```

```sql
-- DRAFT 0015 integration_resources: what an administrator explicitly registered on an ORGANIZATION connection.

create table public.integration_resources (
  id                   uuid primary key default gen_random_uuid(),
  connection_id        uuid not null,
  connection_kind      text not null default 'organization' check (connection_kind = 'organization'),
  provider_resource_id text not null check (length(provider_resource_id) between 1 and 200 and provider_resource_id <> '*'),
  resource_type        text not null check (resource_type in ('page','database','data_source')),
  visibility           text not null check (visibility in ('org_members','admins')),
  registered_by        uuid references public.profiles(id) on delete set null,
  registered_at        timestamptz not null default now(),
  unique (connection_id, provider_resource_id),
  foreign key (connection_id, connection_kind) references public.integration_connections (id, kind) on delete cascade   -- personal connections can never have registrations
);
alter table public.integration_resources enable row level security;
alter table public.integration_resources force row level security;
revoke all on public.integration_resources from public, anon, authenticated, service_role;
create policy integration_resources_select on public.integration_resources for select to authenticated
  using ((select public.is_admin()) or visibility = 'org_members');
create policy integration_resources_insert on public.integration_resources for insert to authenticated
  with check ((select public.is_admin()) and registered_by = (select auth.uid()));
create policy integration_resources_update on public.integration_resources for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy integration_resources_delete on public.integration_resources for delete to authenticated using ((select public.is_admin()));
grant select, insert, delete on public.integration_resources to authenticated;
grant update (visibility) on public.integration_resources to authenticated;
grant select on public.integration_resources to service_role;
```

Proposed order (each as a `supabase/proposed/*.proposed.sql` file with the usual header, a catalog audit and a PGlite test, then your approval to apply to
`broko-dev`): **0013** connections, oauth_states, audit; **0014** credentials and functions; **0015** resources; **0016** sync state (Phase H, later).
Tests that must exist with them: no table or function in this set is reachable by `anon` or `authenticated` except the listed `select`/policy grants;
`ciphertext` is never selectable by any API role; the partial indexes reject a second live personal connection, a second live organization
connection, and accept a reconnect after a terminal status; a registration on a personal connection is rejected.

## 6. Test coverage added (`tests/integrations-framework.test.ts`, 40 tests)

Personal owner-only isolation (store deliberately over-returns everyone's connections; the other employee's client is never even built; an
administrator cannot use it; two workspaces merge), lifecycle (revoked, disconnected, needs_reauth, error, immediate effect, store failure, factory
failure, signed-out), organization policy (no registration = nothing; only registered pages and database rows; unregistered id refused with no
content; database listing needs the database itself registered; `org_members` vs `admins`; registrations of another connection and the `*`
marker ignored; no reach into a colleague's personal content), legacy (flags, admin only, token only to the legacy id), wiring (flag off
unchanged, demo mode closed, two employees through real chat each see only their own pages, revoke mid-session, meeting tools still
admin-only), and static guarantees (no `fetch`, no logging, no environment reads outside `legacy.ts`, no secret-capable field, no database
client). Two mutations (ownership check removed; per-record cover check removed) were applied and confirmed to fail the suite.

## 7. Decisions needed from the owner before Phase B

1. Legacy token for members: with the framework on it is **administrators only** (stricter than today). Keep, or offer `org_members` visibility?
2. `organization_id`: keep one organization per deployment (matching `CLIENT_DEPLOYMENT.md`), or introduce a tenants table now?
3. **Service-role key in the Next app** (needed for any credential storage, section 5). Alternative: keep credentials in a separate service. Which?
4. Administrators see metadata of employees' personal connections (provider, workspace name, status), not content or tokens. Acceptable?
5. May a registered organization database cover rows only (current), or nested descendants too (needs ancestry resolution, Phase D)?
6. Approval to register a Notion public integration (owner of the developer account, redirect URI per environment): Phase B.
