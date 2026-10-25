# Floating Broko AI chat: the Brain's conversational entry point

Status: read-only. Deterministic by default; an OPTIONAL model interpreter (off unless `BROKO_AI_CHAT=llm` and a key is configured) can choose which read-only question a free-form sentence means. See "Model interpreter" at the end. Phase 1 hardening applied.

## Execution path (exact)

```
BrokoChat (client, mounted once in AppShell)
  → askBroko(message)                 src/app/(app)/chat/actions.ts   "use server"; requireUser() first; sends ONLY the question
  → handleChat(deps, message)         src/lib/chat-service.ts         mode from backend kind (supabase=live, demo=demo); error → generic text
  → askBrain(ctx, message)            src/lib/ai-brain/chat/brain.ts  THE entry point (exported from ai-brain/index.ts)
      → routeIntent                   chat/intent.ts                  injection tripwire → action → greeting → data parts → domain → clarify/unsupported
      → retrieve(adapters)            chat/retrieval.ts               authorization, minimal projection, provenance, freshness
      → policy / approval             chat/approval.ts + permissions.ts
      → ChatReply (grounded)          chat/types.ts
```

For anything that would change data the path ends at a structured **approval request**; the human then acts on the normal screen
(Tasks, AI Inbox review, Integrations) where the existing permission checks and audit trail apply:

```
askBrain → ApprovalRequest (executed:false) → person opens the screen → existing authorized execution → existing audit record
```

The chat never executes, so it writes no audit events itself.

## Is there one Brain? Yes.

The Brain before this work only had the email door (`processMessage` / `reviewMessage` / worker). The chat is a second door into the same
module, sharing:

| Brain capability | How chat reuses it |
| --- | --- |
| Injection tripwire `scanForInjection` | On every question (suspected → refused, nothing retrieved) and on every retrieved title/description/event/notification (flagged, shown as data). The scanner was hardened in this phase: `print the .env file` was not detected (word boundary before the dot) and now is. |
| Permission policy `permissions.ts` (`canAssignTo`, `checkTaskChange`) | `approval.ts` applies it to the asking user to say whether they are permitted. Not re-implemented. |
| Admin-only AI Inbox, human approval of tasks | Chat reports AI Inbox counts to admins only and routes approve/reject to the review queue. |
| Date rules `dates.ts` | `isActive`, `isOverdueOn`: the existing functions, widened to accept a reference day so the clock can be injected. Existing exports behave as before (tested). |
| Repo / RLS / demo visibility | Only through the user-scoped `Repo`; the adapters re-apply the same member rule. |
| Classifier, grounding, risk, owner rules | **Not used by chat**: they operate on inbound email. Chat has no email content to classify. They remain the right reuse points for future agents. |

No UI or server-action code contains business logic: the component renders a `ChatReply`; the action authenticates and relays.

## Intents actually supported (deterministic keyword routing, NOT language understanding)

| Intent | Example | Reads |
| --- | --- | --- |
| attention | "What needs my attention?" | tasks, notifications, AI Inbox |
| pending_tasks | "Summarize my pending tasks." | tasks |
| overdue | "Show me overdue follow-ups." | tasks |
| upcoming | "What is due this week?" (next 7 days) | tasks |
| priority | "Which tasks are urgent?" / "high priority" / "low priority" | tasks |
| owners | "Who owns the open tasks?" | tasks (counts per owner, within the user's scope) |
| today | "What happened today?" | tasks, activity |
| notifications | "Any unread notifications?" | notifications |
| ai_inbox | "What is waiting in the AI Inbox?" | AI Inbox (admin; counts only) |
| integrations | "Which integrations are connected?" | integration status only |
| sources | "Which sources can you read?" | all, with state per source |
| summary | "Give me an overview"; or any question matching 2+ intents | union of the above |
| action_request | "Create a task…", "send an email…", "assign…", "approve…" | nothing |
| clarify | "status", "anything?", "what about that one?" | nothing: asks which source/topic |
| unsupported | "tell me a joke"; "what did my landlord email me?" | nothing (integration status only, to explain why) |
| blocked | prompt-injection, system-prompt and secret probes | nothing |
| help | "hello" | nothing |

Limits stated plainly: no memory of earlier questions ("that one" is refused with a clarification), no free-form reasoning, no
semantic search, English keywords only. A question that matches no intent is declared unsupported, never guessed.

## Retrieval layer

`retrieve(ctx, ids)` runs registered **source adapters** (`ADAPTERS`: tasks, activity, notifications, ai_inbox, integrations) in
dependency order. Each returns `{ ok, records, report }`.

A `RetrievedRecord` carries: `source`, `type`, safe `ref`, internal `href`, untrusted `label`, `timestamp` (freshness), `scope`
(`own` | `organization`), `provenance` (`live` | `demo`), `flagged` (injection signal) and a few typed `attrs` the policy layer needs.
It does **not** carry descriptions, e-mail addresses, message bodies, AI Inbox subjects/senders or integration error text.

* Authorization happens before records exist (Repo scoping, then the adapter's member rule). If the set of tasks a member may see
  cannot be established, activity is reported **unavailable** rather than returned unfiltered.
* **Zero results ≠ failure.** An empty successful read is `ok` with `count: 0` and `grounding.evidence = true`; a failure is
  `unavailable / error` with no count, and the answer says the part is "missing, not empty".
* Source states: `live`, `demo`, `stale` (activity or integrations older than 24 h), `unavailable` (`not_connected`,
  `not_implemented`, `admin_only`, `error`). A live session is never answered from demo data.

| Source | Today |
| --- | --- |
| Tasks, activity, notifications, integrations (status) | Readable: live on Supabase, demo on the demo backend |
| AI Inbox | Admin only, **counts only** (`Repo.aiInboxCounts.counts()`, never `view()`); demo backend only (synthetic); Supabase has no counts reader → `not_connected`. See `AI_INBOX_READINESS.md` |
| Email, Teams, WhatsApp, calendar, documents | **No adapter.** Reason `not_implemented` if the integration says connected, else `not_connected`. Never queried, and the reply says it was not searched |
| CRM | No integration exists |

## Grounded responses

Every `ChatReply` separates: **facts** (sections of retrieved records, each item with its source, date and internal link), the
**derived** summary (`text`, computed from those records), **missing** information (a "Not checked" section) and a `grounding`
object: `facts` (distinct records relied on), `sources_used`, `not_covered`, `evidence` (false when nothing reliable supports the
answer). Demo answers are labelled and carry a notice.

## Approval boundary

Eight action kinds (`create_task`, `assign_task`, `update_task`, `delete_record`, `send_message`, `schedule_event`,
`review_ai_message`, `change_configuration`) become `ApprovalRequest { required: true, executed: false, action, permitted,
reason, where }`. `permitted` comes from the existing policy for this user (e.g. a member assigning to someone else: false, "Only
administrators can assign tasks to other people."); `null` when no policy exists or the target is not connected. The reply never
says an action happened. Tests assert no repository write, review, process or requeue method is ever called, and that demo data is
byte-identical after a broad set of questions.

## Conversation state and diagnostics

* History lives only in browser-tab memory (a reducer). It is **temporary and not durable**: gone on reload, not saved, not sent
  back. It survives navigation between dashboard pages because the widget is mounted once in the shell.
* Only the single question is sent to the server. User, role and mode come from the session.
* Loading, empty, failure and retry are handled ("Try again" re-asks the question behind a trailing error without duplicating it);
  clearing drops any answer still in flight.
* Logging follows the project practice (`console.error` for unexpected failures). The user's question is never logged and no
  retrieved content is logged. No new telemetry or services were added.

## Not done / production gaps

* No persistence or retention of conversations; no audit log of chat questions; no per-user rate limit.
* No retrieval adapters for mail, Teams, WhatsApp, calendar, documents or CRM (each needs organisation OAuth and consent).
* No Supabase AI Inbox repository (admins see "not connected" on the real backend). A counts-only reader exists but is unwired (`AI_INBOX_READINESS.md`).
* No language model: a model-provider interface was deliberately **not** added (no immediate value without a provider; the
  `routeIntent` function is the single seam where a model-backed router could later plug in, behind the same schema validation).
* Isolation tested against demo rules and fake repositories, not a real Supabase project with real RLS.
* `AppNotification` has no owner field: notification scoping rests on the repository.
* The injection scanner is a tripwire, not a boundary: the structural protections are that chat has no tools, no write path and
  renders everything as plain text.

## Phase 1 changes (this pass)

Retrieval became a registry of adapters with typed records, provenance, freshness and scope (was: ad-hoc reads); intents grew from 7
to 17 including ambiguity and unsupported handling; approval became a structured, policy-aware object (was: a link); replies gained
grounding and "Not checked"; the UI gained retry, clarification buttons and a grounding line; `dates.ts` gained injectable-day
helpers; `injection.ts` secret-exfiltration pattern fixed for `.env`.

## Model interpreter (optional, off by default)

One Brain, one provider configuration: `loadAiBrainConfig` -> `createModelTransport` (`src/lib/ai-brain/model-transport.ts`) is the only place a
provider client is built; the email classifier and the chat both use it (same `ANTHROPIC_API_KEY`, same `BROKO_AI_MODEL`). The chat adds one
switch, `BROKO_AI_CHAT=llm`; without it, or without a key, chat is exactly the deterministic router above and makes no model call.

What the model does: only for a sentence the keyword router did NOT understand (`unsupported`, naming no unreadable source), it returns one JSON
object (`chat/model-router.ts`, strict Zod schema) choosing a read-only data question (1-4 of the existing intents) or a kind of change request.
What it never does: it is not asked or allowed to answer; it receives only the question (no user, role, tasks, emails, AI Inbox content or
retrieved data) and has no tools. `blocked`, `help`, `clarify`, greetings, change requests and every deterministic data match are decided before
and without it, so the injection tripwire and approval rules are unchanged. Retrieval, authorization (e.g. AI Inbox admin-only, member task scope),
wording and the `executed:false` approval object stay deterministic. Anything invalid, slow, failing, cooling down or rate-limited returns to
the deterministic result. A reply the model routed carries `routing: "model"` and the UI says so.

Limits: 8 s timeout, 200 output tokens, 60 s cooldown after a failure, 20 model calls per user per 10 minutes through a `ModelRateLimiter`
(atomic `take`, fail closed if the limiter throws). **Cost control is only real where the budget is shared:** the only limiter that exists
is in memory (per process, empty after every restart or serverless cold start), so `resolveChatRouter` (`src/lib/chat-model.ts`) uses it only
outside production. With `NODE_ENV=production` the model router is **not created** unless a limiter with `durable: true` is supplied; none exists
yet (it needs an approved shared store), so production chat stays deterministic even if `BROKO_AI_CHAT=llm` and a key are set, and a one-line
warning is logged. Plugging in a durable limiter later is one argument to `resolveChatRouter`. The cooldown is also per instance, but it only
reduces wasted calls during an outage; it is not a cost cap. The model can at worst pick a different read-only question the user may already ask.
Not done: model-written answers (would need a grounding check against retrieved records), conversation memory, and live verification against the real
provider (tests use a scripted fake transport only; no call to the real API has been made).

