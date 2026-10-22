# AI audit events and the Activity feed

Status: **implemented for the demo backend** (local, uncommitted). Persistence is demo-only, see "Implemented". Based on commit `f065c80`.

## What exists today

**Event taxonomy (reuse it, do not extend it).** `EventType` in `src/lib/types.ts` has nine values:
`email_received`, `message_classified`, `potential_task_identified`, `task_created`, `task_assigned`,
`task_updated`, `task_completed`, `notification_sent`, `workflow_failed`. The same list is a CHECK constraint on
`activity_events.event_type` in `supabase/migrations/0001_init.sql`, together with `status` in
`processed | pending | failed` and a `metadata jsonb` column. Adding a type needs a migration.

**Feed shape.** `ActivityEvent` = `{ id, event_type, description, status, actor_id, related_task_id, related_task_title, created_at }`.
It has no metadata, no correlation id and no classifier information. `ActivityFeed` renders only those fields.
Consumers: Overview (`listActivity(6)`), the AI Inbox fallback view (filters AI event types), task detail (`listTaskActivity`).
Visibility rule (RLS and demo): administrators see all; members only events they caused or tied to a task they can see.

**AI audit port.** `AuditEvent` in `src/lib/ai-brain/ports.ts` = `{ event_type, status, description, dedupe_key, stage, at, meta }`
with `meta` a flat map of strings, numbers and booleans.

## Which AI events are emitted, discarded or persisted

| Emitted by the pipeline | Event type used | Persisted in the demo? |
| --- | --- | --- |
| Email received | `email_received` | No, discarded |
| Classified (intent, confidence, status, flag count) | `message_classified` | No, discarded |
| Potential task identified | `potential_task_identified` | No, discarded |
| Reviewer approved / rejected | `message_classified` (with `meta.decision`) | No, discarded |
| Task created | `task_created` | **Partly**: the demo repo records its own `task_created` / `task_assigned` events through the normal task path, not from the AI audit event |
| Notification sent / failed | `notification_sent` / `workflow_failed` | No, discarded |
| Any stage failure | `workflow_failed` | No, discarded |

The demo builds a fresh in-memory `InMemoryAuditSink` on every request and throws it away, so the Activity feed
shows none of the AI steps. Only the task-side events exist, and only for approved tasks.

## Gaps found

1. **Unsafe reference.** The audit `dedupe_key` contains the RFC 5322 Message-ID. It must not reach the feed or `metadata`.
   The non-reversible `sourceRef(dedupe_key)` (12 hex characters, already used on tasks) is the safe identifier.
2. **No classifier mode** on events (it is only on the message record since `f065c80`).
3. **Actor and decision are free-form `meta` keys** (`reviewed_by`, `decision`), not typed.
4. **Review decisions reuse `message_classified`.** The taxonomy has no review-decision type. Keep it (no migration) and make the decision a typed field.
5. **No correlation id** tying one email's events together except the unsafe key.
6. **Demo storage is a 4 KB signed cookie.** It cannot hold an event log.

## Contract (implemented)

Keep `AuditSink.record()`. Extend the event, not the taxonomy:

```ts
interface AiAuditEvent extends AuditEvent {
  workflow_id: string;            // sourceRef(dedupe_key): safe, stable per email, never the Message-ID
  message_ref: string;            // same value; kept separate so a task-level ref can differ later
  task_id: string | null;
  classifier: { mode: "rules" | "llm"; fallback_reason: FallbackReason | null } | null;
  outcome: ProcessingStatus | null;
  flags: RiskFlag[];              // enum values only
  error_category: PipelineStage | null;   // category, never an error message
  actor: { kind: "user" | "system"; id: string } | null;
  decision: "approved" | "rejected" | null;
}
```

* **Content-free:** no subject, body, sender, contact details, prompts, model output or error text. Enums and ids only.
* **Mapping to the feed:** one `ActivityEvent` per audit event: same `event_type` and `status`, a fixed-vocabulary `description`,
  `actor_id`, `related_task_id` when a task exists, and the extra fields under `metadata` in the database.
* **Read path:** `Repo.listActivity()` merges task events with AI events, so the Overview, AI Inbox and task detail pages need no new endpoint.
* **Database:** `activity_events` already fits (`metadata jsonb`, nullable `related_task_id`). No new table.
  Writes come from the service role or the admin-checked approval functions in the proposed `0003`.
* **Demo:** rebuild the events deterministically from the synthetic pipeline on each request, as the messages already are,
  and overlay the visitor's approve/reject decisions. This needs no extra cookie storage.

## Implemented

* `AuditEvent` (`src/lib/ai-brain/ports.ts`) is now typed: `workflow_id` (hashed `sourceRef`), `task_id`, `classifier` {mode, fallback_reason},
  `intent`, `outcome`, `flags`, `error_category`, `actor`, `decision`. `dedupe_key` and the free-form `meta` map were **removed**.
* `describeAudit()` (`src/lib/ai-brain/activity.ts`) builds every description from those enums. Previously descriptions embedded the email
  subject and the AI-written task title, and `meta` carried error text; both are gone.
* `toActivityEvents()` maps audit events onto `ActivityEvent`, adds typed `metadata`, and skips an AI `task_created` when the backend already
  records its own `task_created` (no duplicate feed entries). `parseActivityMetadata()` validates `activity_events.metadata` read back from a
  database (exact shape or dropped); the Supabase repo now selects and parses it.
* No new event type and no migration. Human review requested = `potential_task_identified` with status `pending`; approve/reject =
  `message_classified` with `decision` and `actor`.
* Feed: `ActivityFeed` shows decision / classifier / risk-flag badges and renders unknown event types or statuses safely
  (`src/lib/activity-presentation.ts`). The AI Inbox page has an "AI activity" card.

## Demo persistence (honest status)

| Thing | Where it lives | Survives refresh | Survives "Reset demo" / 24 h |
| --- | --- | --- | --- |
| Pipeline events (received, classified, potential task, failures) | Regenerated from the synthetic emails on every request | Yes (deterministic) | n/a, regenerated |
| Approval | The task itself (deterministic id) in the demo cookie: creator and time are real | Yes | No |
| Rejection | `[index, reviewer, time]` in the demo cookie | Yes | No |
| Events emitted during a review call | Request-scoped memory | **No, discarded** (the decision event is rebuilt from the stored facts instead) | n/a |

The demo cookie is a per-browser signed cookie, not a database. Nothing is durable across browsers, resets or 24 h.
Pipeline events are stamped "yesterday" relative to now so they sort with the sample tasks; they are not real timestamps.

## Remaining limitations

* No real persistence: a database-backed `AuditSink` writing `activity_events` (service role or the admin-checked functions in the proposed `0003`) is not built.
* In model mode, a non-cached Overview load for an administrator runs the classification (cached for 10 minutes); a background worker would remove this.
* Approved decision events in the feed link to the task, whose title (AI-written, may include the sender's name) is shown as it is for every task event.
* Old demo cookies that stored rejections as bare numbers are ignored (the rejection reappears as pending).

## Decision for Broko

None for this increment. A database-backed audit sink needs the organisation-owned database decision.
