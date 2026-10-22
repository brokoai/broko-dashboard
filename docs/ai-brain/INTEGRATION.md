# AI Brain: persistence and dashboard integration (stage 2)

Scope of this stage: put the Communication Agent inside the existing dashboard (AI Inbox with
approval), using the existing `Backend`/`Repo` interfaces, **with synthetic data only**. Nothing here
reads a mailbox, calls a language model, or touches a database. Nothing has been pushed or deployed.

## What changed in the dashboard

| Piece | Where | Notes |
| --- | --- | --- |
| Optional backend capability | `Repo.aiInbox?: AiInboxRepo` in `src/lib/backend/types.ts` | `view()` and `review()`. A backend without it shows "not connected". |
| Demo implementation | `src/lib/backend/demo/ai-inbox.ts`, wired in `demo/repo.ts` | Runs the sample emails through the real pipeline per request. Only the visitor's decisions are stored. |
| Task creation | Through the demo `Repo` task path (`createAiTask`) | `source = "email"`, `external_reference = synthetic-email:<n>`, creator = the reviewer. Deterministic id `ai<n>` makes approval idempotent. |
| Review action | `src/app/(app)/inbox/actions.ts`, `src/lib/ai-review-input.ts` | Authenticates first, validates input, relays to the backend. Reviewer identity comes from the session only. |
| UI | `src/app/(app)/inbox/page.tsx`, `src/components/ai-inbox-list.tsx` | Existing components, responsive, labelled "Synthetic". Admin-only. |
| Supabase backend | unchanged | Has no `aiInbox`, so the real backend shows "not connected" rather than pretending. |

Approving creates one task with the demo's normal activity event (`task_created`). Rejections are stored
by index and are not shown in the activity feed (demo limitation).

## Minimum persistence required (and what each need maps to)

| Need | Minimum | Proposed in `supabase/proposed/0003_ai_brain.proposed.sql` |
| --- | --- | --- |
| Incoming message reference | sender, subject, ids, hash, no body | `ai_messages` row (excerpt NULL by default) |
| Processing job state | one status per message | `ai_messages.status`, `error` |
| Idempotency | unique key per email; unique task per email | `ai_messages.dedupe_key` primary key; partial unique index on `tasks(source, external_reference)` |
| Approval decisions | who, when, outcome | `reviewed_by`, `reviewed_at`, `status`; changed only by `ai_approve_message` / `ai_reject_message` (admin-checked, row-locked) |
| Audit events | content-free event per stage | **No new table.** Existing `activity_events` (service role writes; types already exist) |

Everything else (policy, owner rules) stays in configuration, not in tables, until Broko wants to edit them in the UI.

## Review of the proposed task-table guard change

0002 forces every browser-inserted task to `source = 'manual'`. Approval must create `source = 'email'`.

* **First draft rejected:** a transaction-local setting read by the guard. A security rule would depend on state
  that any SQL-capable code path in the session can set.
* **Current proposal:** make the guard `SECURITY INVOKER` and trust only inserts executed by a role other than
  `authenticated`/`anon`. Only the admin-checked `SECURITY DEFINER` approval function does that. No client-writable state is trusted.
* **Alternative considered:** the Next.js server writes with the service-role key after checking the admin in code.
  Simpler, but it moves the only authorization into application code and puts a powerful key in the web tier. Not recommended.
* **Not verified.** Four points to confirm on a disposable Supabase branch are listed in the SQL comments. No migration
  (0002 or 0003) should be applied until Broko confirms the project and owner, and this is tested there.

## Status

**Implemented and tested (synthetic data, demo backend):** AI Inbox page (admin only), review queue, approve, reject,
task creation with source linkage, duplicate suppression (same Message-ID in a second mailbox), reviewer overrides
checked against the assignment rule, permission checks, malformed-request validation, bounded storage, error state
when demo storage is full. 19 new tests plus the existing suite.

**Simulated:** the sample emails (synthetic provider, rule-based classifier, fixed clock), the owner rules (demo users),
and the notification state ("not configured", never claimed as sent).

**Not built / blocked:**

| Item | Blocked by |
| --- | --- |
| Reading real mail (Outlook/Gmail adapter) | Provider choice, organisation-owned OAuth app, admin consent |
| LLM classification live | Organisation Anthropic account and key, budget; adapter only tested with fakes |
| Persistent store and Supabase `aiInbox` | Confirmed production project and owner; approval to apply migrations; guard verification |
| Notifications | Delivery channel decision (email, Teams, in-app) |
| Audit events in the Activity feed for AI steps | Needs the persistent store (demo cannot hold them) |
| Rate limits / ingest trigger / worker | Where the worker runs; Vercel Hobby cron limits |
| Overview and Team pages showing AI-created work | Works already via normal tasks; AI-specific widgets not built |

## Decisions needed from Broko before any live integration

1. **Mailbox provider:** Microsoft 365/Outlook or Gmail (and which mailboxes, named)?
2. **Production database/backend:** which organisation-owned project exists, and who administers it? (No Supabase project has been created.)
3. **Ownership of GitHub and hosting:** the repo is under a personal GitHub account and is public; Vercel is Hobby. Who owns and administers the production accounts, and when do they move to organisation control?
4. **Ownership rules:** who gets viewings, finance, legal, complaints, and what is the fallback? Which sender domains are verified?
5. **Notifications:** where should they go (in-app only, email, Teams, other)?
