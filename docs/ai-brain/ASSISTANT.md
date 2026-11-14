# Broko AI Assistant: Phase 1 (extension of the existing Central Brain)

Status: **local code and tests only.** No Supabase project was contacted, no migration was written or applied, no external account (Microsoft, Notion) was touched, nothing was committed, pushed or deployed. Not production-ready.

The Assistant is the existing floating Broko chat and the existing Brain, extended. There is no second chatbot, Brain, model router, knowledge store or chat backend.

## 1. Architecture discovered (verified in the code, not assumed)

```
BrokoChat (src/components/broko-chat.tsx, mounted once in AppShell)
  -> askBroko(message, projectId?)    src/app/(app)/chat/actions.ts    "use server"; requireUser(); sends ONLY the question
  -> handleChat(deps, message)        src/lib/chat-service.ts          mode from backend kind; metadata-only audit (best effort, 3 s)
  -> askBrain(ctx, message, opts)     src/lib/ai-brain/chat/brain.ts   THE entry point
        routeIntent                   chat/intent.ts                   tripwire -> action -> greeting -> data parts -> domain -> clarify/unsupported
        tryPrecon / tryKnowledge      chat/precon.ts, chat/knowledge.ts   project scope and approved Knowledge, BEFORE any model
        optional model router         chat/model-router.ts             only picks WHICH read-only question; never writes the answer
        retrieve(adapters)            chat/retrieval.ts                user-scoped repository + re-applied visibility rules
        ChatReply                     chat/types.ts                    sections (facts / derived / recommendation / missing), sources, grounding
```

Existing and unchanged in behaviour: deterministic task, activity, notification, AI Inbox and integration answers; approved-Knowledge retrieval (`status = approved`, in effect, not expired, project items only for projects the user can see); Pre-Construction retrieval and project scope; the injection tripwire; the model router and its rate limiter; the AI unlock; metadata-only `chat_audit`; chat history held only in the browser tab (by design: see RETENTION.md).

## 2. What Phase 1 added

| Piece | File | Purpose |
|---|---|---|
| Tool registry | `src/lib/ai-brain/assistant/tools.ts` | Typed contracts: id, description, strict input schema, required role, read / prepare / write class, timeout, provenance note. `runTool` validates, checks permission, bounds time, sanitises and flags returned text, and never throws. Write-capable contracts have no backend and are always refused. |
| Connector interfaces | `src/lib/ai-brain/assistant/connectors.ts` | `NotionConnector`, `OutlookMailConnector`, `OutlookCalendarConnector` (read and prepare only; no send/create/update/delete method exists). The only implementation is `unavailableConnectors()`: every call returns `not_connected`. |
| Action proposals | `src/lib/ai-brain/assistant/proposals.ts` | Typed `ActionProposal` (id, requester, type, target system, parameters, digest, description, created, expiry, approval state, execution state, result ref). `prepareProposal`, `decideProposal` (requester only, pending, unexpired, exact parameter digest), `executeProposal` (no executor registered: cannot run). |
| Brain wiring | `chat/brain.ts`, `chat/types.ts`, `chat/prompts.ts` | Action requests now carry a display-only `proposal`; every source has `retrieved_at`; fixed `follow_ups`; a visibly separate `recommendation` section for the attention and overdue answers (fixed wording, no record text). |
| Interface | `src/components/broko-chat-view.tsx` | Recommendation block, proposal card ("Not done"), follow-up buttons, "Read HH:MM UTC" per source. Existing history, loading, error/retry, source chips and suggested prompts are kept. |
| Query coverage | `chat/knowledge.ts`, `lib/knowledge/search.ts`, `chat/intent.ts` | "What does our approved procedure say?" and "What did we decide?" (a question that names only a kind) now return the most recently approved items of that kind instead of a false "nothing found". "Notion" is recognised as a source the Assistant cannot read yet. |

## 2a. Brain handlers now run through the registry (milestone 2)

The Brain's reads of Tasks, Activity, Notifications, AI Inbox, Integrations and approved Knowledge execute as registry tools. The tools wrap the existing adapters (same code, same authorization); there is no second implementation.

```
askBrain -> routeIntent -> (tripwire / action / greeting short-circuit: NO tool runs)
         -> answerData / answerUnsupported / tryKnowledge / withProjectKnowledge
              -> retrieveViaTools(ctx, sources)            assistant/brain-tools.ts
                   -> retrieve(ctx, ids, exec)             chat/retrieval.ts  (dependency order and parallelism, unchanged)
                        -> runTool(registry, "broko.<source>.<verb>", {}, toolContext)   assistant/tools.ts
                             validate input -> role check -> timeout-bounded run
                             -> existing adapter (ADAPTERS[x].retrieve / loadKnowledge)  user-scoped, approval rules, injection flags
                             -> Outcome handed back in-process as `native`
              -> deterministic wording, sources (+ retrieved_at), grounding, follow-ups
```

If a tool fails (timeout, exception, refused role) the source is reported unavailable with the adapters' fixed "could not be read" wording and nothing is substituted. A refusal that carries its own reason (for example Knowledge "not connected") keeps that exact report.

| Existing Brain read | Registry tool | Wraps | Used by |
|---|---|---|---|
| Tasks | `broko.tasks.list` | `ADAPTERS.tasks` | pending, overdue, upcoming, priority, owners, attention, today, summary |
| Activity | `broko.activity.list` | `ADAPTERS.activity` (reads Tasks from the shared outcome map) | today, summary |
| Notifications | `broko.notifications.list` | `ADAPTERS.notifications` | notifications, attention, summary |
| AI Inbox status | `broko.ai_inbox.status` | `ADAPTERS.ai_inbox` | ai_inbox, attention, summary |
| Integration status | `broko.integrations.status` | `ADAPTERS.integrations` | integrations, and the reason a source is unreadable |
| Approved Knowledge | `broko.knowledge.list` | `loadKnowledge` (approved, current, visible only) | knowledge questions, project notes |

Not routed through the registry (out of scope for this milestone): Pre-Construction project/document/inventory reads (`chat/precon.ts`), which keep their own project-scope checks and are unchanged; the optional model router (it still only picks a read-only question). Email, Notion and calendar tools exist as contracts and return `not_connected`; the Brain does not call them yet and still answers those questions with the existing honest "I cannot read it yet" reply.

A request context can carry its own registry (`BrainChatContext.tools`), which is how tests prove the Brain executes through the registry: replacing a tool changes the answer and the repository is never reached around it.

## 2b. Notion connector (read-only, milestone 3)

`src/lib/ai-brain/assistant/notion.ts` (server-only) implements `NotionConnector` over Notion API version `2022-06-28` with `NOTION_API_KEY`. Four request shapes only: `POST /search`, `GET /pages/{id}`, `GET /blocks/{id}/children`, `POST /databases/{id}/query` (a read). No create, edit, delete or comment code exists, and a test pins that.

- Tools: `notion.pages.search`, `notion.pages.get` (title, link, up to 1500 characters of plain text from text blocks), `notion.databases.query` (row titles and links). Routed from `chat/notion.ts` when a question names Notion; it runs after the approved-Knowledge path and never for blocked, action, help or clarify.
- Provenance on every result: title, Notion id, Notion URL, kind and last-edited date, retrieval time.
- Failure handling: 401 -> not connected (falls back to the existing "cannot read it yet" reply), 403/404 -> refused or not shared, 429 -> rate limited, timeouts (6 s per request) and any other error -> a fixed code. No response body or token is ever copied into a result.
- Untrusted content: control characters removed, instruction-like text flagged, URLs limited to `https://*.notion.so|site`, never sent to a model by the plain Notion search (meeting analysis, section 2c, sends one page to the model after sanitising), never promoted to approved Knowledge.
- Access boundary: the integration sees only pages and databases shared with it. This is workspace-level, not per employee; every signed-in employee gets the same Notion view. The demo (synthetic visitors) can never reach Notion, whatever the environment holds.
- Audit: Notion answers are recorded as source `documents` and intent `knowledge`, because `chat_audit` only accepts its fixed vocabulary. A distinct `notion` source/intent needs a reviewed migration.
- Not done: live verification against a real Notion workspace (all tests use an injected fake `fetch`), pagination beyond the first results, page content beyond text blocks, per-employee Notion permissions.

## 2c. Notion Meeting Intelligence (V1)

Questions such as "Summarize the meeting on 23 October at 1 PM", "What decisions were made in our last client meeting?" or "Extract the action items from the marketing meeting" are answered in the existing chat from the real Notion page. One pipeline, each stage a separate module:

| Stage | Where | Notes |
|---|---|---|
| Understand | `assistant/meetings/request.ts`, `datetime.ts` | Deterministic (no model): intent (`meeting_summary / _decisions / _action_items / _content / _all`), date, time, time zone, title keywords, a quoted exact title, "latest". A date with no year stays without a year; an ambiguous date (3/4) becomes a question. Zone: named in the question (UTC, GMT, IST, EST/EDT, PST/PDT, CET or an IANA name), else `BROKO_TIMEZONE`, else UTC; the answer states the zone used. |
| Authorize | `chat/meetings.ts`, registry `requires: "admin"` | Fails closed, see below. |
| Find | tool `notion.meetings.find` -> `NotionConnector.findMeetingCandidates` | Three parallel searches (keywords, "meeting", most recently edited pages), merged and de-duplicated; titles, dates and links only. Date comes from a date property, else the creation time. |
| Select | `selectMeetings` | Exact: title, keywords (all must match), calendar day and time (29-minute tolerance) compared in the question's zone. Several matches -> Broko asks, each option re-asks about exactly one meeting. None -> says so; nothing is invented. |
| Read | tool `notion.meetings.read` -> `readMeetingDocument` | Page properties plus all blocks: 100 per request with `next_cursor`, nested blocks to depth 4, child pages, tables, to-dos. Limits: 800 blocks, 60 requests, 3.5 s start-of-request deadline. Anything not read is recorded in `coverage` and shown ("Partial: ..."). A page that cannot be read is a failure, never an empty document. |
| Normalize | `meetings/analysis.ts` `sanitizeDocument` | Numbered segments `S1..Sn` with the source block id, control characters removed, 1200 characters per segment, instruction-like segments flagged. |
| Analyse | `chat/synthesizer.ts`, `chat-model.ts` | The existing Anthropic transport, key and model (`BROKO_AI_MODEL`). Only the one meeting's segments are sent: no user identity, no other records, no tools. Flagged passages are withheld. Input capped at 24,000 characters (a cut is reported), 1,800 output tokens, 25 s timeout. Behind the existing AI unlock and the same fail-closed production rule, with its own budget (10 per user per hour, 100 per day overall; `BROKO_AI_SYNTH_USER_MAX`, `BROKO_AI_SYNTH_GLOBAL_MAX`; durable Redis in production). |
| Validate | `validateAnalysis` | Strict schema. Every claim needs refs to segments the model was given; claims whose words and numbers are not in the cited text are removed; links and instruction-like text not in the source are removed; an owner or deadline is kept only if its words are written in the cited segment; inferred decisions are kept apart from explicit ones; a mostly unsupported answer is discarded. |
| Format | `chat/meeting-format.ts` | Overview, key discussion points, decisions, inferred (labelled), action items with "Owner: ... Deadline: ..." (or "not recorded"), open questions, risks, follow-ups, limitations, the source link, retrieval time and content coverage. Each item carries its source ids. |

**Fallback.** No model, a budget that is used up, a timeout, a transport error, invalid JSON, or a failed validation all give the deterministic view: the page's own text sorted by its headings (decisions, action items, to-dos, questions), no summary, no owner or deadline. The reply says which of these happened. The reply's `generation` is `model_synthesised` only when a validated model analysis is shown, and the chat then says so.

**Authorization (known limitation, fail closed).** Notion access is workspace-wide: Broko sees what was shared with the integration, not what each employee could open. Employee-level authorization cannot be established, so the meeting tools are administrator-only (`requires: "admin"` in the registry, plus a check before any source is contacted). A member gets an explanation and nothing is read. The existing plain "Search Notion for ..." answer (section 2b) is unchanged and still available to every signed-in user; tightening it is a separate decision.

**Not built / limits.** Follow-up questions have no memory ("who was assigned them?" needs the meeting named again; the buttons carry the title and date). Very long pages are analysed from the first 24,000 characters only. Notion AI "meeting notes" blocks that the public API does not expose are not read. Time of day is checked only when the page's date property has one. No Outlook or Teams (the `PROVIDERS` list and `MeetingCandidate`/`MeetingDocument` types are source-neutral so they can be added). No migration: audit rows record `used_model` and nothing about the meeting; token counts are not recorded (they would need a `chat_audit` change).

## 3. Supported queries (A to H)

| | Question | Handled by | Notes |
|---|---|---|---|
| A | What needs my attention today? | `attention` (+ `today`) | Overdue, high priority, unread, AI Inbox; recommendation block |
| B | Show me my most critical tasks. | `priority` (urgent) | Priority and due date shown |
| C | Show me overdue follow-ups. | `overdue` | States that email/Teams/WhatsApp follow-ups are not visible |
| D | Summarize what happened today. | `today` | Activity feed + due today, or "nothing recorded" |
| E | What are the current priorities? | `priority` | High and urgent |
| F | What did we decide about this project? | `knowledge` / `preconstruction` | Approved project notes for projects the user can see |
| G | What does our approved procedure say? | `knowledge` | Approved, current items only |
| H | Summarize this project using the information available to me. | `preconstruction` | Project scope validated and authorised on every question |

Email, Notion and calendar are never reported as checked. Questions about them answer "I cannot read it yet, I did not search it".

## 4. Security properties (and where they are tested)

All in `tests/assistant-phase1.test.ts`, plus the existing 856 tests.

- Reads are user-scoped; another employee's task never appears (tools and chat).
- Proposed, rejected, expired and redacted Knowledge never influences an answer.
- Retrieved text is data: control characters removed, instruction-like text flagged, `javascript:` URLs dropped, never obeyed.
- No write runs: write contracts are refused, proposals are pending and not executable, `executeProposal` has no executor, approval is bound to an exact parameter digest, a different or edited action cannot ride on an approval.
- Connector failures, timeouts and thrown errors become fixed-vocabulary results with no source text or message.
- The metadata-only audit entry is unchanged and contains neither the proposal nor the message.
- No tool accepts a URL, SQL or command.

## 5. Database changes

None. Proposals are not stored (no table, no migration), so in Phase 1 they can be displayed but not approved. An approval store, if wanted, needs its own reviewed migration.

## 6. Future connector contracts (not built, no account touched)

Common rules: acts as the signed-in employee only; delegated least-privilege consent; tokens server-side only, never in prompts, logs, audit rows or replies; everything returned is untrusted data; no external write without an approved proposal for exactly those parameters.

### Notion
Read-only to start. Methods: `searchPages`, `getPage`. Use a Notion integration limited to the pages explicitly shared with it (read content capability only; no insert or update). Content from Notion is never promoted to approved Knowledge automatically.

### Outlook email (Microsoft Graph, delegated)
Read and prepare. Methods: `searchMessages`, `getThread`, `findUnanswered`, `prepareReplyDraft`. Candidate delegated permissions (to be confirmed against current Microsoft documentation when an app is registered): `User.Read`, `offline_access`, `Mail.Read` (own mailbox only). Do **not** request `Mail.Send`, `Mail.ReadWrite`, or any `.Shared` scope in Phase 1; reply drafts are kept in Broko and shown for review, so no Graph write permission is needed. Full email bodies are not logged or stored in audit tables.

### Outlook calendar (Microsoft Graph, delegated)
Read and prepare. Methods: `listEvents`, `checkAvailability`, `findConflicts`, `prepareEventProposal`. Candidate delegated permissions (confirm at registration): `Calendars.Read`. Not requested: `Calendars.ReadWrite`. Creating, changing or deleting an event is a separate later milestone and needs an approved proposal plus a registered executor.

Microsoft and Notion applications are **not** registered, and no credential has been requested.

## 7. Limitations

- Connectors are interfaces only; email, Notion and calendar answers are always "not connected".
- Proposals are display-only, not persisted, and carry only the request's own words (not typed parameters such as recipients or times).
- Chat history stays in the browser tab. Persisting it would store conversation content, which the current retention design deliberately avoids; it needs an explicit decision.
- Notion answers show the page excerpt and link as written. The Assistant does not write summaries or extract key decisions or pending tasks (no model is involved); a request for those gets the text plus a note saying so.
- A message that names Notion is answered from Notion even if it also mentions tasks (the tasks part is not answered; the reply says so). Template text such as `[EXACT PAGE TITLE]` is not searched; the Assistant asks for the real page title.
- Pre-Construction reads still bypass the registry (their own scope checks are intact). Each registry read adds a per-tool timeout (8 s); a source slower than that is now reported as not read.
- The `native` result a tool returns to the Brain is an in-process object (an adapter outcome). It is never serialised, but a future tool author must not put secrets in it.
- Intent matching is keyword-based. Free-form wording outside the covered phrasings gets a clarification or "unsupported", unless the optional model router is on.
- Live behaviour (Supabase, browser session) is not tested in this phase.

## 8. Recommended next milestone

1. Route Pre-Construction reads through the registry and add a retrieval-planning step (still deterministic first).
2. Microsoft Graph read-only connector for the signed-in employee (own mailbox and calendar), behind the existing unavailable stub, with a reviewed consent and token-storage design.
3. Notion read-only connector.
4. A reviewed migration for a proposal/approval store, then the approval screen and the first executor (task changes, which Broko owns).
