# Security & Migration Review

Scope: the dashboard code in this repo and `supabase/migrations/0001_init.sql`.
Method: code reading, automated tests against the **demo** backend, `curl`/browser tests against a local server, and a client-bundle scan.

**Not done:** nothing here was run against a real database or identity provider. The SQL was **read, not executed**; no statement in it has been verified to work, and no policy has been verified to enforce anything. Treat every statement about the database as *unverified*.

## A. Application code

### Fixed in this pass (verified in demo mode)

| ID | Finding | Fix | Evidence |
|---|---|---|---|
| A-1 | **Member could reassign a task to someone else by editing it.** `createTask` checked the "members assign only to themselves" rule; `updateTask` did not, and the demo backend didn't either. The RLS update policy in 0001 doesn't either (see H-1). | Rule moved to `src/lib/permissions.ts`, applied to create, update and status change; demo backend enforces it too. | Unit tests; browser: tampered edit rejected with "Only administrators can assign…", legitimate edit still saves. |
| A-2 | **Raw database error messages were returned to the browser** (`e.message`). | Only `UserFacingError` text is shown; everything else is logged server-side and replaced with a generic message. | Code; type-checked. Not exercised against a real DB error. |
| A-3 | **Every user's email was serialized to every browser** (profile list passed to client components). | New `Person {id, full_name}` type; `listPeople()` returns no contact data. | Unit test "people picker exposes no contact details". |
| A-4 | Task history only showed events within the latest 100 across all tasks. | `listTaskActivity(taskId)` added to the contract. | Unit test; browser. |
| A-5 | (Earlier pass) Protected pages were prerendered at build as a cached "redirect to /login". | Session read always touches `cookies()`; all app routes are dynamic. | Build output; `curl`. |
| A-6 | Proxy threw (HTTP 500) if the auth service was unreachable. | Fails closed to `/login`. | Code only; not exercised. |
| A-7 | Demo mode was only guarded by `NODE_ENV`; demo code was statically bundled. | Also refuses on `BROKO_ENV`/`VERCEL_ENV=production` and AWS Lambda env; demo module is lazily imported; unconfigured production has no sign-in. | `next start` with `BROKO_DEMO_MODE=true`: login says "Sign-in is not configured", forged `broko_demo_user` cookie is redirected to `/login` on `/`, `/tasks`, `/team`, `/integrations`. |
| A-8 | Integrations page text implied an admin could "mark as connected". | Text now says it is set only by a real connection check. | Visual. |

### Verified as already correct

* Unauthenticated requests to every app route → 307 `/login`.
* A member cannot read another member's task by URL (`Task not found`, title not leaked) or its history.
* Member cannot assign to others on create (tampered form rejected server-side).
* Client JS bundle contains no `SUPABASE_SERVICE_ROLE_KEY`, no `service_role`, and no demo account strings (scanned `.next/static` with sentinel env values). `NEXT_PUBLIC_*` values are the only variables that may reach the browser by design.
* User identity (id, role) is always re-derived from the validated server session; no client-supplied user id or role is trusted. Task ids from the client are loaded through the user-scoped repo first.
* Server-side validation of title length, dates, status and priority values.
* Production dependency audit: 0 vulnerabilities (`npm audit --omit=dev`).

### Open (need a decision or real infrastructure)

| ID | Issue | Severity | Note |
|---|---|---|---|
| R-1 | No security headers / CSP / HSTS configured. | Medium | Deployment-dependent; add once hosting is known. |
| R-2 | No sign-in rate limiting or lockout in the app. | Medium | Must come from the identity provider/edge. |
| R-3 | Permission rules exist twice (app + backend). | Design | Intentional defence in depth, but they must be kept in sync; the backend must be the stricter one. |
| R-4 | Filter/sort/search runs in the browser over the full visible list. | Low now | Move server-side before volumes grow. |
| R-5 | "Due today/overdue" uses UTC days. | Low | Need Broko's business time zone. |
| R-6 | Demo cookie is unsigned and not `Secure`. | Info | Demo only; unreachable in production (A-7). |
| R-7 | 5 high advisories in **dev-only** lint tooling (`braces` via eslint-config-next). | Low | Not shipped; the offered fix is a breaking downgrade, so not applied. |
| R-8 | There is no admin-only UI yet; `requireAdmin()` is unused. Role currently only changes data visibility and assignment rights. | Info | Fine for Phase 1. |
| R-9 | No audit of sign-ins / role changes / deletes. | Medium | Backend work (see requirements §7). |

## B. `supabase/migrations/0001_init.sql` (read-only review)

### Structure & relationships — OK on reading

Foreign keys, check constraints, defaults and indexes are consistent with the dashboard's types. `auth.users → profiles` creation trigger, `updated_at`/`completed_at` triggers and the activity-logging trigger match the app's expectations. `SECURITY DEFINER` functions set `search_path`. The activity and notification tables have no INSERT policies for users, so only triggers/service role write them.

### Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| H-1 | **High** | **Tasks: the UPDATE policy checks only visibility.** A member who created or is assigned a task can set `assigned_to` to anyone, and via the API can change `created_by`, `source` (e.g. spoof `ai`) and `external_reference`; on INSERT they can set `source`. The app now blocks this in code, but a direct API call would not be blocked. | Proposed fix: `tasks_guard` trigger in `supabase/proposed/0002_hardening.proposed.sql`. Unverified. |
| H-2 | **High** | **Integrations: any admin can set `status = 'connected'`**, which violates "never claim connected until verified". | Proposed `integrations_guard`: only the service role/verification worker can set connected/error/last_sync. Unverified. |
| M-1 | Medium | **Greenfield assumptions.** Assumes an empty database: unqualified generic table names (`profiles`, `tasks`, `notifications`, `integrations`) likely to collide with an existing system; plain `CREATE TABLE` (not idempotent); seed `INSERT` fails on re-run; depends on Supabase's `auth` schema, `auth.uid()` and `authenticated` role; creates a trigger on `auth.users`; single-tenant, no organisation key. | **Do not apply to any existing database.** If Postgres is chosen, put Broko's objects in their own schema, adapt to existing user/task tables and add a tenant key if the DB is shared. |
| M-2 | Medium | **First-admin bootstrap fails.** `guard_profile_update` raises unless `is_admin()`, which is false when `auth.uid()` is null (SQL editor, service role). So `update profiles set role='admin'` as documented in README cannot work as written. (Read, not executed.) | Proposed fix in 0002 (allow when `auth.uid() is null`). |
| M-3 | Medium | A member can update their own `email` column on `profiles` (guard covers only role/title). | Proposed fix in 0002. |
| M-4 | Medium | `profiles_read USING (true)`: every signed-in user can read every colleague's **email** through the API (the dashboard no longer sends it to browsers, but the API allows it). | Optional fix in 0002 (commented; needs repo change). |
| M-5 | Medium | **`team_workload()` is not administrator-only.** It is executable by every authenticated user and returns names, titles, roles and task *counts* for all members. This is what the Team page uses, but it differs from the "administrator-only" description in the brief. | **Decision needed.** If it must be admin-only, add `if not public.is_admin() then raise exception` and hide the page for members. |
| M-6 | Medium | If the project allows public sign-up, anyone can create a user and gets a `member` profile (can read names, integration status, etc.). | Disable sign-ups / invite-only in the identity provider. |
| L-1 | Low | New tasks created already assigned to someone else produce no notification (only reassignment does). | Proposed in 0002. |
| L-2 | Low | Users may update any column of their own notifications (not just `read_at`). | Proposed column grant. |
| L-3 | Low | Trigger/internal functions are executable via RPC by default. | Proposed `REVOKE`. **Verify `handle_new_user` still fires on staging.** |
| L-4 | Low | No index on `activity_events.actor_id`. | Proposed. |
| L-5 | Low | Task deletion (admin) is not audit-logged and `ON DELETE SET NULL` detaches history. | Consider soft-delete or `RESTRICT`; log deletes. |
| L-6 | Low | No protection against demoting/removing the last admin. | Operational decision. |

### Privilege-escalation paths considered

| Path | Result (by reading) |
|---|---|
| Member sets own `role`/`title` | Blocked by `guard_profile_update` (still true after M-2/M-3 fixes). |
| Member updates another profile | Blocked by `profiles_update_self` policy. |
| Member reads other members' tasks | Blocked by `tasks_select`; `activity_select` joins through `tasks` RLS. |
| Member reassigns tasks / spoofs `source` / rewrites `created_by` | **Possible** (H-1). |
| Admin sets integration to "connected" | **Possible** (H-2). |
| Anyone calls `team_workload()` | Allowed by design (M-5). |
| `anon` role | No policies granted to `anon`; `team_workload` revoked from `anon`. |
| Service-role key | Unused by the dashboard; must stay server-only. |

## C. What would count as "verified"

Only these, run against a real non-production backend by Broko's team or with their access: sign-in/sign-out, each role's task visibility, forged-id and tampered-payload attempts against the real API, status/assignment rules, activity rows written by the backend, integration status rules, and a secrets scan of the deployed bundle. None have been run.
