# Backend Integration Requirements

Status: **draft for Broko's technical team**. The production backend (AWS, Supabase or other) has **not** been chosen. Nothing in this repository is connected to, or verified against, a real backend. Everything here is the contract the dashboard needs, whichever backend provides it.

**MUST** = the dashboard cannot work without it. **LATER** = optional / future phase.

## 1. How the code is organised

| Piece | Location | Notes |
|---|---|---|
| Contract (TypeScript) | `src/lib/backend/types.ts` | `Repo` (data) and `Backend` (auth + data). A new backend only implements these. |
| Backend selector | `src/lib/backend/index.ts` | Add one line to select a new implementation. Implementations are lazy-imported. |
| Supabase implementation | `src/lib/backend/supabase/` | Unverified against a live project. |
| Demo implementation | `src/lib/backend/demo/` | In-memory, fake data. Never loaded unless `BROKO_DEMO_MODE=true` and not production. |
| Business rules (backend-independent) | `src/lib/permissions.ts` | Applied in server actions before every write. |
| UI | `src/components`, `src/app` | Talks only to `Repo`/`Backend`. No database types leak into components. |

To add AWS (or anything else): create `src/lib/backend/<name>/index.ts` exporting a `Backend`, return it from `getBackend()`, add the proxy session check in `src/proxy.ts` if the session mechanism differs from cookies. The UI does not change.

The dashboard calls the backend **from the Next.js server only** (server components / server actions). The browser never talks to the data store directly with privileged credentials.

## 2. Authentication (MUST)

| Requirement | Detail |
|---|---|
| Sign in | Email + password (or SSO, LATER). `Backend.signInWithPassword(email, password)` returns `{error?}`. Error text must be generic ("Invalid email or password") and must not reveal whether the email exists. |
| Sign out | `Backend.signOut()` invalidates the session server-side and clears cookies. |
| Session | `Backend.getCurrentUser()` must **validate the session on the server on every request** (verify signature/expiry/revocation), not merely check a cookie exists. Cookies: `HttpOnly`, `Secure`, `SameSite=Lax` or stricter. |
| Session refresh | Handled in `src/proxy.ts` / the backend module. If the auth service is unreachable the app **fails closed** (redirects to sign-in). |
| Public sign-up | **Disabled / invite-only.** Anyone who can self-register would get a profile and read team names. |
| Profile | One profile per user: `id`, `full_name`, `email`, `role`, `title`. The signed-in user's name, role and title shown in the UI come from this record, never from code. |
| Roles | `admin` and `member` (MUST). Roles are changeable only by an admin or a trusted maintenance path. A user must not be able to change their own role or title. |
| First administrator | Needs a documented bootstrap path (see Security review, finding M-2). |
| Rate limiting / lockout | Required on sign-in (backend or edge). LATER: MFA. |

Company leadership (Pankaj Arora, Founder & CEO) is currently a static record in `src/config/company.ts`. It is deliberately **not** tied to the logged-in user. LATER: serve it from a company record in the backend.

## 3. Tasks (MUST)

Task fields: `id`, `title` (1–200), `description`, `status` (`open | in_progress | completed | cancelled`), `priority` (`low | medium | high | urgent`), `assigned_to`, `created_by`, `due_at`, `source`, `external_reference`, `created_at`, `updated_at`, `completed_at`. Reads also return the assignee's display name.

| Operation | Contract |
|---|---|
| `listTasks()` | Admin: all tasks. Member: only tasks assigned to or created by them. Filtering, search and sort are currently done in the browser over this list (fine for Phase 1 volumes). **If the list can grow beyond a few thousand rows, move filtering/sorting/pagination into the backend** (LATER). |
| `getTask(id)` | Same visibility rule. A task the user may not see must be indistinguishable from one that does not exist (`null`). |
| `createTask(input)` | `created_by` = the authenticated user, set **by the backend**, never trusted from the client. `source` is `manual` for human-created tasks (set by the backend). Members may assign only to themselves or leave unassigned; admins to anyone. |
| `updateTask(id, patch)` | Allowed for admin, assignee, or creator. Same assignment rule: only admins may assign a task to another person. `created_by`, `source`, `external_reference`, `created_at` are immutable to humans. |
| Status rules | `completed_at` is set when status becomes `completed` and cleared when it leaves it. Done by the backend, not the client. |
| `taskCounts()` | KPI counts over the tasks the user may see: `open` (open + in_progress), `due_today`, `overdue` (active tasks with `due_at` before today), `completed`. Must be computed in the backend (counts, not row fetches) and respect the same visibility. |
| Day boundary | Due dates are currently **UTC calendar days**. Broko must confirm the business time zone; until then "today/overdue" can be off by a day for users in other zones. |
| Delete | Not exposed in the UI. If added, admin-only and audit-logged. |
| `listPeople()` | `{id, full_name}` only, for pickers. **Must not return emails or other contact data** to members. |

## 4. Activity (MUST)

Event fields: `id`, `event_type`, `description`, `status` (`processed | pending | failed`), `actor_id`, `related_task_id`, `created_at`.

| Requirement | Detail |
|---|---|
| Recording | Task create, assign, status change and completion are recorded **by the backend** (trigger / service layer), in the same transaction as the change, so they cannot be skipped or forged by a client. The UI never writes events. |
| Actor | `actor_id` is the authenticated user. System/automation events have no actor and are written only by a trusted service identity (LATER, when n8n/AI exists). |
| `listActivity(limit)` | Newest first. Admin: all events. Member: events they caused or that relate to a task they can see. |
| `listTaskActivity(taskId, limit)` | Events for one task, only if the task is visible; otherwise empty. |
| Integrity | Events are append-only for users (no update/delete). |
| Titles | The task title is resolved at read time (join), so renamed tasks show the current title. |
| AI event types | `email_received`, `message_classified`, `potential_task_identified`, `notification_sent`, `workflow_failed` exist in the schema but **nothing writes them yet** (LATER). The AI Inbox shows an empty state until real records exist. |

## 5. Integrations (MUST for the status page; connections themselves LATER)

Providers: Microsoft Outlook, Teams, Calendar, OneDrive, Gmail, Google Calendar, WhatsApp Business.

| Requirement | Detail |
|---|---|
| Status per provider | `connected | disconnected | pending_setup | error`. Default and fallback is `pending_setup`. |
| `connected` | May be set **only by a verified connection check performed by a trusted service**, never by a dashboard user clicking a button and never by default. The dashboard must show "Connected" only if the backend says so. |
| Last sync | `last_sync_at` is the last **successful** sync; shown with the status. |
| Errors | `last_error` is a short, sanitised message. Never include tokens, URLs with secrets, stack traces or raw provider responses. |
| Secrets | OAuth tokens, API keys and webhook secrets are stored in a secrets manager (e.g. AWS Secrets Manager / Supabase Vault) and used only by the connector service. **They never live in the table the dashboard reads and are never sent to the browser.** |

## 6. Notifications (MUST for the bell; delivery channels LATER)

`listNotifications()` returns only the user's own notifications. Created by the backend on events such as task assignment. Mark-as-read is not yet in the UI. Email/Teams/WhatsApp delivery is LATER.

## 7. Security requirements (MUST)

1. **Server-side authorization on every operation.** Hiding buttons is not a control. The dashboard checks rules in server actions (`src/lib/permissions.ts`) **and** the backend must enforce the same rules independently (database policies or API authorizer), so a stolen session or direct API call cannot exceed them.
2. **Least privilege.** The dashboard connects as the signed-in user. A privileged/service credential (e.g. Supabase service-role, AWS admin keys) must **never** be used by the dashboard's user-facing code paths and never exposed to the browser. It is reserved for the future automation worker.
3. **Role-based permissions**: admin vs member as in sections 3–5. Members must not receive unrestricted access to every record.
4. **Tenant / record boundaries.** Currently single-company. If Broko shares the backend with other products or tenants, every table needs a tenant key and policies on it. Do not reuse tables from other applications without that.
5. **Secure credential handling.** Secrets only in environment/secrets manager, never in the repo, logs, client bundles or error messages. The client bundle was scanned: no secrets (see the review).
6. **Audit logging.** Task changes are recorded (section 4). LATER: log sign-ins, role changes, integration status changes, deletes, and admin reads of other people's data.
7. **Error hygiene.** Internal errors are logged server-side and replaced by a generic message in the UI; only `UserFacingError` text reaches users.
8. **Demo mode must not exist in production.** It is disabled when `NODE_ENV=production` or common production signals are present, and the demo module is only loaded on demand.
9. **Transport & headers (deployment concern).** HTTPS only, HSTS, a Content-Security-Policy, and CSRF protection (Next.js server actions check `Origin`). Not yet configured in this repo.

## 8. Information needed from Broko's technical team

1. Which backend/hosting is in use (AWS services, Supabase, other) and who owns it.
2. Existing identity provider (Cognito, Entra ID/Microsoft 365, Google Workspace, Auth0, ...). SSO is likely preferable to passwords given Microsoft/Google integrations.
3. Existing user/employee and task tables, if any (to avoid duplicating them) and their naming/conventions.
4. Whether the database is shared with other apps (namespace/tenant needs).
5. Business time zone and working days.
6. How the first administrator is created, and who may create users.
7. Environments (dev/staging/prod) and where secrets are stored.
8. Data-retention / audit requirements.

Credentials must be provided through Broko's secret-handling process, not in chat or the repo.

## 9. Environment variables (names only)

Current: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (only if the Supabase backend is chosen), `SUPABASE_SERVICE_ROLE_KEY` (reserved, currently unused), `BROKO_DEMO_MODE` (local development only). A different backend will define its own names in `.env.example`.

## 10. Reference schema

`supabase/migrations/0001_init.sql` is **one possible implementation** of this contract for a *new* Postgres/Supabase database. It has not been applied anywhere and has known issues; read `docs/SECURITY_AND_MIGRATION_REVIEW.md` before using it. `supabase/proposed/0002_hardening.proposed.sql` holds proposed fixes (also unapplied and unverified).
