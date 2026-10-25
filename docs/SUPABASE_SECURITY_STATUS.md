# Supabase security status: what is enforced, what is only proposed, what is open

Read this before any real business data is allowed near the database. It is deliberately conservative: a finding is called
**enforced** only when both the database and the application do what is claimed, and a database claim counts only once it has
been applied and verified on a real project. As of this writing **nothing has been applied to any remote database.**

Evidence labels:
- **Verified locally** = executed on a local PostgreSQL that imitates Supabase's roles and defaults (see the limits in
  `docs/SUPABASE_CLI_ROLE_MODEL.md`). It does not prove behaviour on a real Supabase project.
- **Proposed** = written in `supabase/proposed/`, not promoted to `supabase/migrations/`, not applied.

| ID | Finding | Database fix | Application | Status today | Evidence | Still needed before real data |
| --- | --- | --- | --- | --- | --- | --- |
| Defaults | Supabase auto-grants every new `public` table, sequence and function to `anon`, `authenticated`, `service_role`, including TRUNCATE (RLS does not stop it) | `0001` revokes and re-grants explicitly (least privilege); `0005` (optional) stops the auto-grant for future objects | none needed | **0001: proposed edit to the active migration, not applied.** 0005: proposed, not enabled | Verified locally (202 checks; baseline 83) | Apply `0001`; decide on `0005` |
| H-1 | A member can reassign a task to someone else with a plain UPDATE | `tasks_guard` trigger in `0002`/`0003` (privilege-level column grants in `0001` also stop forging `source`, `external_reference`, `created_by`) | `checkTaskChange` / `canAssignTo` enforce it in server actions and the demo backend (unit-tested) | **App: enforced. Database: proposed.** The hole exists in the database until `0002`/`0003` are promoted and applied | Verified locally (before: succeeds; after: 42501) | Promote and apply `0002`, then `0003`; re-run the findings script and the read-only assertions on the dev project |
| M-4 | Any signed-in user can read every colleague's email from `profiles` | `0006`: column-level SELECT without `email` | `PROFILE_COLUMNS` no longer reads `email`; the user's own email comes from the auth session (`src/lib/backend/supabase/profile.ts`) | **App: ready (changed locally, uncommitted). Database: proposed.** The exposure exists until `0006` is applied | Verified locally; contract test checks every column the app reads | Apply `0006` **together with** the app change; check sign-in on the dev project |
| H-2 | An admin could mark an integration "connected" by hand | `0001`: `authenticated` has SELECT only on `integrations` (privilege level). `0002` adds a guard trigger as a second layer | The UI has no control for it | **Database: proposed in 0001 edit.** Not applied | Verified locally (admin session refused; service role can set it) | Apply; the worker must verify a real connection before writing `connected`; sanitize `last_error` before storing it |
| M-2 | The first admin cannot be promoted (the guard blocks even the SQL editor) | `0001`: the guard only restricts sessions that carry a user id | none | **Proposed in 0001 edit.** Not applied | Verified locally: promotion by owner and by service role works; a member cannot self-promote; an admin session cannot change roles through the API | Follow the bootstrap procedure below |
| M-5 | `team_workload()` returns names, titles and task counts for everyone to any signed-in user | not changed | the Team page uses it | **Open: a decision is needed** | n/a | Decide whether members may see it; if not, add an `is_admin()` check and hide the page |
| M-6 | If sign-ups are open, anyone can create a user and gets a `member` profile | Cannot be fixed in SQL: it is an Auth project setting | none | **Open: a dashboard setting, not verified** | Not checked | Disable public sign-ups (invite only) in the Supabase Auth settings and record that it was checked |
| L-5 | Deleting a task is not audit-logged | not changed | clients cannot delete (no DELETE grant) | **Open (low)**; client deletion is now impossible by privilege | n/a | Soft delete or an event on delete before any admin delete feature is built |
| L-6 | Nothing stops the last admin being demoted | not changed | roles are changed only server-side now | **Open (operational)** | Shown locally: the service role can demote the last admin | Operational rule, or a guard trigger |

## Phase closure (2026-10-25): which migrations matter for the next development build

Local hardening is closed. Nothing was applied anywhere. The dashboard's Supabase repository covers tasks, people, activity,
integrations, workload and notifications; the AI Inbox, job queue and worker exist only against the in-memory demo backend.

| File | Status |
| --- | --- |
| `0001_init.sql` | Locally reviewed (last-admin guard added, no extensions). Superseded rows above: **L-6 and M-2 are addressed in the file** (still unapplied). |
| `0002_hardening` | Locally reviewed. Apply together with `0001`. Needed for H-1/H-2. |
| `0003_ai_brain`, `0004_ai_jobs` | Proposed only. **NOT APPROVED FOR APPLICATION**: no consumer yet. Deferred to the AI Inbox integration. |
| `0005_default_privileges` | Proposed only. Changes platform defaults for future objects; needs remote verification. Optional. |
| `0006_profiles_privacy` | Locally reviewed; the app already avoids reading `profiles.email`. Apply with the app version in this tree. |

Two-session behaviour (`SKIP LOCKED`, approval row lock, stale-lease fence) was exercised once on a disposable local PostgreSQL 18.4 on
2026-10-25 and behaved as designed (see `docs/ai-brain/REMOTE_VERIFICATION_CHECKLIST.md`, section 8). Still needs a real Supabase to
establish (neither PGlite nor that run can): effective PostgREST/GoTrue privileges, and deleting an auth user that is the last administrator.

## First-admin bootstrap (procedure, once `0001` is applied)

1. Create the user through Supabase Auth (invite only). The `on_auth_user_created` trigger creates a `member` profile.
2. In the SQL editor (runs as `postgres`, no user session) run: `update public.profiles set role = 'admin' where id = '<that user id>';`
3. Verify as that user: sign in, and confirm administrator behaviour. Roles can never be changed through the API (no UPDATE privilege
   on `profiles` for `authenticated`), only by `postgres` or `service_role`.

## Future objects: a migration-only permission model

Every object is created by a reviewed migration that **ends with its own explicit grants** (template in
`supabase/proposed/0005_default_privileges.proposed.sql`). Objects created in the dashboard Table Editor are not a supported path.
If `0005` is later enabled, such objects are also invisible to the API until a migration grants access.
`tests/sql-security.test.ts` enforces: no grant to `anon`/`public`, no broad grant, RLS enabled explicitly, `search_path` pinned,
`EXECUTE` revoked from `PUBLIC`, role save/restore in every file.

## What must be true before real business data is allowed

- `0001` applied and `supabase/proposed/tests/0001_privileges.proposed.sql` passes on the dev project.
- `0002`/`0003` promoted and applied (H-1 enforced in the database), `0006` applied together with the app change (M-4).
- Public sign-ups disabled and checked; M-5 decided; the first admin created by the procedure above.
- Retention period and a data-protection decision for stored sender and subject (see the AI Brain docs).
- No credential in the repository, the CLI folder `supabase/.temp/` ignored (done), and a check of the linked project reference before
  every push (`olngcbgkxbceqpikcyxk` is `broko-dev`; the other project in the organisation must never be targeted).
