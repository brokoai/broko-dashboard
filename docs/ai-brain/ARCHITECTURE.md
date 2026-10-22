# Broko AI Brain — Communication Agent (Phase 1): architecture

Principle: **centralise intelligence, decentralise responsibility.** One pipeline understands mail;
configured rules and people decide who owns the work. The model never assigns, approves or sends.

Status of this document: describes code in `src/lib/ai-brain/` and `tests/ai-brain-*.test.ts`.
Nothing here is wired into the deployed dashboard yet, and nothing has run against a real mailbox,
a real language model, or a real database. See [Status matrix](#status-matrix).

## A. Assessment of what existed

| Area | Finding |
| --- | --- |
| Dashboard | Next.js 16 / React 19 / Tailwind 4, deployed on Vercel Hobby from GitHub; responsive; passwordless synthetic demo with signed per-visitor cookies. |
| Task model | `Task` with `source`, `external_reference`, `assigned_to`, `priority`, `due_at`; `TaskInput` is the creation contract. |
| Backend contract | `Backend` / `Repo` (`src/lib/backend/types.ts`), a demo backend, and an **unverified** Supabase backend. |
| Permissions | `checkTaskChange` / `canAssignTo`: members assign only to themselves, admins to anyone. Reused unchanged. |
| Activity | `activity_events` types already include `email_received`, `message_classified`, `potential_task_identified`, `task_created`, `notification_sent`, `workflow_failed`. The AI audit trail maps onto them. |
| Integrations | A status model exists (`pending_setup` etc.); no email integration exists. |
| Hosting/ownership | GitHub repo is under a personal user account and is public; Vercel is Hobby. Real tenant data must not enter the public repo. Production resources should move to organisation-controlled accounts before real data flows. |

## B. What was missing (and is now built, simulated, or blocked)

Typed contracts, provider-neutral ports, normalisation, injection tripwire, grounding, owner rules,
risk/priority/deadline policy, classifier (rule-based + LLM adapter), pipeline with idempotency and
review/approval, audit events, task mapping, config loader, synthetic fixtures, and tests: **built**.
Real email adapters, live LLM call, database persistence, notification delivery, dashboard UI:
**not built / blocked** (see matrix).

## Pipeline

```
 EmailProvider (read-only, ports.ts)              untrusted
        │ RawEmail
        ▼
 NORMALIZE   normalize.ts   strip HTML/hidden text/invisible chars/quoted thread; cap size; hash
        │ NormalizedMessage (strict zod)
        ▼
 CLAIM       ProcessingStore.claim()   atomic, keyed by dedupe key  ──► duplicate? stop
        │
        ▼
 CLASSIFY    Classifier.analyze()      model sees only normalised text, no tools   (untrusted out)
        │ unknown
        ▼
 VALIDATE    MessageAnalysisSchema     z.strictObject, enums, ranges; extra keys rejected
        │
        ▼
 GROUND      grounding.ts              drop contact/ref/date/urgency the message does not support
        │
        ▼
 ASSESS      policy.ts + injection.ts  risk flags (system ∪ model), priority, deadline
        │
        ▼
 OWNER       owners.ts                 configured rules → assignable person or none
        │
        ▼
 DECIDE      policy.decide()           NO_ACTION | REVIEW_REQUIRED | APPROVED (+reasons)
        │
        ├─ REVIEW_REQUIRED ─► admin reviewMessage(): approve (compare-and-set) │ reject
        └─ APPROVED (opt-in policy only) ─► TaskSink.createTask(system actor)
                                              │ idempotent on dedupe key
                                              ▼
                                       Notifier.notify()  (never claimed unless sent)
 AUDIT: every stage emits a content-free AuditEvent.
```

Stage inputs/outputs are the types in `schema.ts`; ports are in `ports.ts`:
`EmailProvider`, `Classifier`, `ProcessingStore`, `TaskSink`, `Notifier`, `AuditSink`.
A future specialised agent plugs in as another `Classifier` + schema + rules; the claim, review,
task and audit machinery is shared.

## Decision rules (default policy)

* `auto_create: "never"`: **every** proposed task waits for an administrator.
* Opt-in `low_risk` still requires: confidence ≥ `min_confidence`, intent not in `always_review_intents`
  (payments, legal, offers, complaints), **no** risk flag (so a sender must be on `verified_sender_domains`),
  nothing missing, an owner from the rules, and a task backend that permits the system actor.
* Owner: highest-priority matching rule whose person is assignable; otherwise unassigned. Conditions are
  structural (intent, property prefix, minimum urgency), never free-text keywords.
* Deadline: the date the sender wrote (grounded), else a configured SLA, else none. Never invented.
* Priority: from urgency evidence in the sender's own words; risk may raise, never lower.

## Idempotency and concurrency

Dedupe key = tenant + RFC 5322 Message-ID (same mail in two mailboxes is one item), falling back to
provider + mailbox + id. `claim()` and `transition()` are atomic compare-and-set; the in-memory store is
for tests only. Database enforcement is proposed in `supabase/proposed/0003_ai_brain.proposed.sql`
(primary key on `dedupe_key`, partial unique index on `tasks(source, external_reference)`, row lock in the
approval function). Tests cover replay, second mailbox, 5-way concurrent delivery, concurrent approval,
and loss of the processing store (backend idempotency still holds).

## Schemas and interfaces

`MessageAnalysisSchema` fields: `requires_action, intent, summary, requested_action, urgency,
urgency_evidence, confidence, contact{name,email,phone}, property_reference, requested_date{date,evidence},
missing_information, risk_flags, proposed_task{title,description}, clarification_question`.
It deliberately has **no** owner, status, approval or task-id field; unknown keys are rejected.
Proposed persistence: `supabase/proposed/0003_ai_brain.proposed.sql` (`ai_messages`, unique index, approval function).

## Status matrix

| Item | State |
| --- | --- |
| Contracts, validation, normalisation, grounding, owner rules, policy, pipeline, review flow, audit events | **Implemented and unit/integration tested** (163 tests in the repo suite, all synthetic) |
| Rule-based classifier | **Implemented**, deterministic, modest confidence; baseline only |
| LLM classifier + Anthropic transport | **Implemented, tested with fake transports/fetch only. Never called the live API.** |
| Email ingestion (Microsoft Graph / Gmail) | **Not built.** Provider port + honest "pending_setup" placeholder only. Blocked on org OAuth app + admin consent. |
| Synthetic email provider | **Simulated** (fixtures, `synthetic: true`, never shown as connected) |
| Persistent processing store / task creation | **Blocked.** In-memory store + fake task sink in tests. SQL is proposed, unapplied, untested against Postgres. |
| Task creation through the real dashboard backend | **Not built** (needs the Supabase backend to be verified first and the `TaskSink` binding). |
| Notifications | **Not built.** `UnconfiguredNotifier` reports "not configured". |
| Dashboard UI (AI Inbox, approvals) | **Implemented for the demo backend with synthetic data** (see INTEGRATION.md). Not connected to a real backend. |
| Rate limiting of the ingest endpoint | **Not built** (no endpoint exists yet). |
| Live security review of deployed behaviour | **Untested** (no deployment). |

## Cost and deployment implications

* No new service is required for the code that exists. Free-tier Vercel hosting is unchanged; nothing was deployed.
* LLM cost is per email when `ANTHROPIC_API_KEY` is set: one request, normalised body ≤ 8,000 characters, small
  JSON output. Use the smallest suitable model; budget before enabling. Without a key the rule-based classifier runs at zero cost.
* Reading mail needs a polling or webhook runner. Vercel Hobby cron is limited (daily, function time limits); a
  continuous inbox poller likely needs a scheduled worker elsewhere or a paid plan. **Decision for Broko.**
* A database (Supabase) is needed for persistence; creating one is a separate authorised step.
* Owner-controlled accounts: create the Anthropic key, OAuth apps, database and hosting under the organisation, not a personal account.

## Decisions needed from Broko

1. Which provider first (Microsoft 365 or Google Workspace) and which mailboxes (named, least privilege).
2. Who creates/owns the Supabase project and Anthropic account (organisation-controlled).
3. Owner rules (who gets viewings, finance, etc.) and verified sender domains.
4. Whether any automatic task creation is ever allowed (default: no).
5. Retention: keep any excerpt? (default: no).
6. Where the polling worker runs, given the free-tier limits above.
