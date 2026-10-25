# Next phase: architecture audit and durable-processing design

Status: audit and design. Section 9 lists what was implemented in this phase and what is only designed.
Baseline when this was written (verified, not assumed): branch `main`, head `a0993ff`, 5 commits ahead of `origin/main`,
clean tree, 210 of 210 tests passing, lint and type-check clean.

Nothing here connects to Outlook, Microsoft Graph, a real Supabase project or any real data. Every migration is a repository
artefact, **not applied and not validated against a database**.

## 1. Current-state architecture (as found in the code)

**AI Brain (`src/lib/ai-brain/`, about 1,750 lines).** `processMessage` runs normalise, atomic claim, classify, strict validation,
grounding, risk assessment, owner rules, decision, optional task creation. `reviewMessage` applies a human decision. Ports:
`EmailProvider` (read-only), `ProcessingStore` (atomic `claim`/`transition`), `TaskSink`, `Notifier`, `AuditSink`, `Classifier`.
Classifiers: rule-based (default) and `LlmClassifier` behind `FallbackClassifier` + `CachingClassifier` (opt-in, `BROKO_AI_CLASSIFIER=llm`).
Safety defaults: `auto_create: "never"`, no sending, owners from configured rules only, model schema has no owner or approval fields.

**Request flow today.** `/inbox` -> `repo.aiInbox.view()` -> demo `build()` runs `processMessage` for every sample email **inside the
page request**. In model mode that is nine model calls while the page waits (measured about 9 s cold). There is no job, no queue and no status
other than the message's own `ProcessingStatus`.

**Backend contract.** `Repo.aiInbox?` is optional (`view`, `review`). Only the demo backend implements it; the Supabase repo has none, so the
real backend shows "not connected". The Supabase adapter uses the anon key plus the user's cookies (RLS applies). **No code references a
service-role key** (`SUPABASE_SERVICE_ROLE_KEY` exists only as a reserved name in `.env.example`).

**Demo persistence.** A signed, 4 KB, per-browser cookie (24 h): changed tasks, up to 8 events, rejections as `[index, reviewer, time]`.
Approvals are the created task (deterministic id `ai<n>`). Pipeline audit events are regenerated per request. Not a database.

**Audit and Activity feed.** Typed `AuditEvent` (hashed `workflow_id`, classifier mode, outcome, flags, safe error category, actor, decision);
descriptions are generated from enums only; mapped to `ActivityEvent` with typed `metadata`; nine existing event types, no migration.

**SQL.** `supabase/migrations/0001_init.sql` (profiles, tasks, activity_events with `metadata jsonb`, notifications, integrations, RLS, triggers
that write `task_created` / `task_assigned` events and reassignment notifications). `supabase/proposed/0002_hardening` and
`0003_ai_brain` are proposals. **None is applied or tested.** 0001 states it is single-tenant with no organisation key.

**Auth boundary.** Demo: signed session cookie; server actions call `requireUser()`; admin checks in the backend. Production: Supabase session via
`proxy.ts`. Demo mode is impossible whenever any `SUPABASE_*` variable is present (`supabasePresent`).

**Worker, queue, scheduling infrastructure: none.** Verified by search: no queue library, cron, `vercel.json`, `.github`, `src/app/api`,
timers or `pg_cron`. Hosting is Vercel (Hobby today); the target is organisation-owned Vercel and Supabase.

## 2. Reusable components

| Component | Reuse |
| --- | --- |
| `processMessage` / `reviewMessage` | Unchanged core of a job; gains a lease-holder takeover option and retry awareness. |
| `ProcessingStore.claim/transition` | Message-level idempotency and compare-and-set. Kept. It is **not** a job queue (no lease, attempts or backoff). |
| `FallbackClassifier`, `CachingClassifier`, `selectClassifier` | Kept; the worker needs the raw model classifier to apply its own timeout/retry policy. |
| `AuditEvent`, `describeAudit`, `toActivityEvents`, `parseActivityMetadata` | Kept; extended (attempt number, idempotency key, two error categories). |
| `reviewAiMessage` action, `parseAiReviewInput`, `checkTaskChange` | Kept; authorization stays server-side. |
| `AiInboxList`, `ActivityFeed`, `activity-presentation` | Extended, not replaced. |
| `0003` approval/reject functions | Extended with confirmed owner, server timestamps and a transactional audit insert. |

## 3. Gaps

1. No durable job: nothing separates enqueue from classification, and nothing survives a restart.
2. No lease, retry, backoff, timeout or abandoned-work recovery. A crashed run leaves the message record stuck in `PROCESSING`
   (`claim` then reports "duplicate" forever).
3. Audit writes are fire-and-forget (`emit` swallows failures silently) and are not idempotent across retries.
4. The message record has a rule-suggested `owner` only: no confirmed owner and no decision timestamp.
5. No status query for the dashboard other than the finished record.
6. The Supabase backend has no AI Inbox implementation, and the SQL is untested.
7. No tenant key in the schema (single-tenant by design; see risk R-3).
8. No server-side job-runner execution environment exists (see section 8).

## 4. Job lifecycle (the durable processing model)

States (the job's own enum; the message `ProcessingStatus` is unchanged and is a different concept):

```
queued -> processing -> completed
              |  ^
   (transient |  | backoff elapsed)
    failure)  v  |
           retry_wait            processing (lease expired, attempts left) -> processing again
              |                  processing (lease expired, attempts exhausted) -> failed
   attempts exhausted            failed -> queued   (administrator requeue only)
              v
            failed (terminal)
```

Mapping to existing names: job `queued` = message `RECEIVED`; `processing` and `retry_wait` = `PROCESSING`; `completed` = the message reached
`NO_ACTION`, `REVIEW_REQUIRED` (or `TASK_CREATED` only under the opt-in policy); `failed` = message `FAILED`.
**Completed means "classified", never "approved".** Approval is a separate human step on a message already in `REVIEW_REQUIRED`
(`APPROVED` is never persisted by a worker). A timeout, malformed output or crash can only move a job to `retry_wait` or `failed`; no path from
those states leads to a task.

| Concern | Design |
| --- | --- |
| Identity / idempotency | `job_key = provider\|mailbox_ref\|source_message_id` (unique). Enqueue is `insert ... on conflict do nothing`. Job id and correlation id are derived from the key (hashed `sourceRef`). Content-level dedupe (same Message-ID in two mailboxes) stays in `ProcessingStore.claim`: the second job completes as `duplicate`. |
| What a job stores | A **reference** only. The email body is fetched from the provider at processing time, held in memory, never persisted by the job, audit or activity tables. |
| Claiming | One atomic statement: select an eligible job `FOR UPDATE SKIP LOCKED`, set `processing`, `attempts + 1`, `lease_owner`, `lease_expires_at`. Eligible = `queued`/`retry_wait` with `next_attempt_at <= now`, or `processing` with an expired lease. |
| Concurrent workers | Two workers cannot claim the same job (row lock + skip). Message-level `claim` is a second guard. |
| Fencing | Every later write (`complete`, `retry`, `fail`) requires `status = processing and lease_owner = me and attempts = my attempt`. A worker that lost its lease cannot overwrite the new owner's result. |
| Lease expiry | Default 60 s, longer than the classification timeout plus fetch time. After expiry the job is reclaimable. If attempts are already exhausted it is marked `failed` (`processing_interrupted`) instead of looping forever. |
| Takeover after a crash | The new lease holder runs the pipeline with `takeOver`, which may resume a message record left in `PROCESSING` or `FAILED`. A record already past classification is reported as processed, not redone. |
| Retries | Default 3 attempts. Backoff `min(cap, base * 2^(attempt-1))` with jitter (injectable for tests); default base 5 s, cap 5 min. Only **transient** failures retry (model unreachable, timeout, fetch error, unexpected internal error). |
| Timeouts | Model call timeout 25 s (aborted), shorter than the lease. A timeout is transient. |
| Invalid model output | **Not retried.** Falls back to the rules immediately (`fallback_reason: model_output_invalid`). Never trusted, never an approval. |
| Rule-based fallback | Model transient failures retry until the last attempt, then fall back to the rules (`model_unavailable`) so a message is not stuck because the model is down. Rules mode (the default) has no model to fail. |
| Terminal failure | `failed` after bounded retries, with a safe error category. Recovery: an administrator can requeue (resets attempts, records who and when). |
| Correlation | `correlation_id` = hashed job reference; once the message is identified, `workflow_id` = hashed dedupe key. Neither reveals content. Attempt number appears on failure events. |
| Observability | Job row: status, attempts, `next_attempt_at`, error category, `audit_failed`. Dashboard reads it through a status query. |

## 5. Proposed data model (Supabase; repository artefacts only)

Preserve existing tables and event types; add only what is demonstrably missing.

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `ai_jobs` (new, `0004`) | Durable job state | unique `job_key`; status check; `attempts <= max_attempts`; lease columns; partial index for claimable jobs; RLS: administrators read, no client writes |
| `ai_messages` (`0003`, revised) | Message reference, analysis, status, suggested and confirmed owner, reviewer and server timestamp | primary key `dedupe_key`; unique `workflow_id`; status check; admin-only select |
| `activity_events` (existing) | Audit trail; AI events carry typed `metadata` incl. `event_key` | new unique index on `(metadata->>'event_key')` where not null (idempotent sink) |
| `tasks` (existing) | Created only by `ai_approve_message` | partial unique index `(source, external_reference)`; guard change as reviewed in `INTEGRATION.md` |

Functions (all `SECURITY DEFINER`, fixed `search_path`, execute revoked from `public`/`anon`):
`ai_enqueue_job`, `ai_claim_job` (service role only), `ai_complete_job` / `ai_retry_job` / `ai_fail_job` (service role, fenced),
`ai_requeue_job` (admin), `ai_approve_message`, `ai_reject_message` (admin; row lock; task creation, status, confirmed owner,
`reviewed_at = now()` and the audit event in **one transaction**, so a decision cannot be reported before it commits).

Ownership: `ai_messages.owner` (jsonb) is the rule-based **suggestion**; `confirmed_owner` (`user_id`, `confirmed_by`, `confirmed_at`) is set only at
approval from the final assignee. `reviewed_by` / `reviewed_at` are `auth.uid()` and `now()` on the server.

Retention (to be decided before real data): `ai_jobs` and `ai_messages` rows and their sender/subject columns need a retention period and a
deletion job; audit events hold no content and can be kept longer. Not defined yet; see section 8.

## 6. Security and privacy risks

| ID | Risk | Status |
| --- | --- | --- |
| R-1 | A worker needs the Supabase **service-role key**. It must never be in the browser or in the Vercel project that serves the demo (any `SUPABASE_*` variable disables demo mode). | Design: separate execution environment; not built |
| R-2 | The worker reads email bodies at processing time. They must stay in memory and out of logs, jobs, audit and errors. | Enforced in code and tests (synthetic) |
| R-3 | Single-tenant schema, no organisation key. Safe only as a dedicated Broko project; unsafe if the database is shared. | Open: needs a tenant key if shared |
| R-4 | Lease/fencing and `SKIP LOCKED` behaviour is designed, not exercised on Postgres. | Unverified |
| R-5 | RLS policies and the guard change in `0003` are untested. | Unverified |
| R-6 | `ai_messages` stores sender and subject; the admin view model also ships `dedupe_key` (contains the Message-ID) to the admin browser. Switch the review handle to the hashed `workflow_id` before real mail. | Open |
| R-7 | Audit writes can fail. They must be visible (job `audit_failed`, review warning) and idempotent. | Implemented in the abstraction |
| R-8 | Prompt injection and model output remain untrusted; unchanged defences (strict schema, grounding, tripwire, rules-owned owners). | Unchanged, tested |
| R-9 | A paid model in a retry loop can cost money. Bounded attempts, timeouts, result cache. | Implemented in the abstraction |
| R-10 | The in-memory job store used by the demo is not durable and not safe across serverless instances. | Labelled; never claimed as production |

## 7. Test and migration strategy

* **Unit/integration (run now, synthetic):** lifecycle transitions, idempotent enqueue, concurrent claims, fencing, lease expiry, retry
  exhaustion with deterministic backoff, timeouts, fallback, invalid output, audit privacy and failure, review authorization and idempotency,
  confirmed vs suggested owner, status rendering, existing demo security.
* **Migrations:** syntax-parse the SQL locally (parser only; proves syntax, **not** behaviour). Then, only on an approved, isolated development
  Supabase project: apply 0001 to 0004 in order; run `supabase/proposed/tests/0004_rls_and_jobs.proposed.sql` (concurrency, RLS, atomic approval, fencing);
  review; only then consider staging. Never apply to a shared or production database from this repository.
* **Rollback:** every proposed migration is additive; rollback = drop the new objects (documented per file). Not exercised.

## 8. Prerequisites for organisational integration (not satisfied; work stops here)

1. Organisation-owned GitHub, Vercel and Supabase accounts exist and Broko names their administrators.
2. A dedicated **development** Supabase project, separate from production, with a named owner and approval to apply migrations there.
3. A decision on where the worker runs (options in `OUTLOOK_INTEGRATION_PLAN.md`): Vercel Cron (Hobby is limited to daily), Supabase
   Edge Function + `pg_cron`, or a small scheduled worker elsewhere. None is created.
4. Retention period and deletion process for message references; data-protection review for storing sender and subject.
5. Owner rules, verified sender domains and a tenant-key decision if the database is ever shared.
6. Rotation of the Anthropic key that was pasted into chat earlier.
7. Entra application registration and admin consent (Outlook; see the integration plan).

## 9. Implemented versus designed in this phase

See "Implementation status" at the end of this document.

## 10. Files proposed for modification

New: `src/lib/ai-brain/jobs.ts`, `src/lib/ai-brain/worker.ts`, `src/lib/backend/demo/ai-runtime.ts`, `src/components/ai-queue-refresh.tsx`,
`supabase/proposed/0004_ai_jobs.proposed.sql`, `supabase/proposed/tests/0004_rls_and_jobs.proposed.sql`, `docs/ai-brain/OUTLOOK_INTEGRATION_PLAN.md`,
`tests/ai-jobs.test.ts`, `tests/ai-worker.test.ts`, `tests/ai-inbox-jobs.test.ts`.
Modified: `schema.ts`, `ports.ts`, `pipeline.ts`, `memory.ts`, `activity.ts`, `classifier-select.ts`, `index.ts`, `demo/ai-inbox.ts`, `demo/repo.ts`,
`backend/types.ts`, `inbox/page.tsx`, `inbox/actions.ts`, `ai-inbox-list.tsx`, `0003_ai_brain.proposed.sql`, the three existing AI Inbox test files, and the docs.

## 11. Implementation status (filled in after the code and tests were run)

**Implemented and tested (synthetic data, test doubles):**
* Job model, `JobStore` port, deterministic backoff, in-memory job store with atomic claims, leases, fencing, abandoned-lease reaping and
  administrator-only requeue (`jobs.ts`, `memory-jobs.ts`). The in-memory store is a test double / local harness and is **not durable**.
* `AiWorker` (`worker.ts`): claim, read by reference, per-attempt classification policy (timeout, bounded retry, immediate rules fallback on invalid
  output, rules fallback on the last attempt, shared circuit breaker), idempotent re-runs, takeover of a crashed run, terminal failure, `audit_failed` flag.
* Pipeline: lease-holder takeover, pending-vs-failed audit events, idempotent audit sink contract (`auditEventKey`), audit failures surfaced
  (`audit_ok`), approval audited only after the task exists, a failed approval leaves no reviewer/time/owner.
* Records carry the **suggested** owner and, separately, the human-**confirmed** owner, reviewer and decision time.
* Dashboard (demo backend): the AI Inbox page only reads; a shared runtime owns the worker; states queued/processing/retry/completed/failed with
  auto-refresh; "Process queue now" and "Retry" (admin only); suggested vs confirmed owner, decision time, evidence, audit history per message.
* Tests: 263 passing (see the final report for the exact commands).

**Designed only (repository artefacts, not applied, not executed):** `0003_ai_brain` (revised), `0004_ai_jobs`, and the isolated-database test script.
They were syntax-parsed with the PostgreSQL parser (outer statements and PL/pgSQL bodies). That proves syntax, not behaviour.

**Not done / blocked:** any database, RLS, locking or atomicity verification; a database-backed `JobStore`/`AuditSink`/`ProcessingStore`; a production
execution environment for the worker; Outlook integration (plan only); retention implementation; the `workflow_id` length decision.

**Known limits of the demo runtime:** one process, memory only, lost on restart, not shared across serverless instances; the page triggers the
worker after the response with `after()`, which a serverless platform may cut short, so "Process queue now" exists as the explicit path.
