# Broko architecture assessment against the Organizational Brain vision

Status: assessment only. No code, migration, commit or deployment came from it. Evidence is from reading the working tree on `feature/brain-chat-audit` (uncommitted) on 2026-11-03.
Labels: **IV** implemented and verified, **INV** implemented but not fully verified, **PI** partially implemented, **NI** not implemented, **P** proposed.
"Verified" means a unit test or a live run exists. Unit tests passing is never counted as production behavior. `docs/MIGRATION_STATUS.md` is the authority on database state, and broko-dev is the only database anything was applied to.

## A. Current architecture map

```
BrokoChat (components/broko-chat.tsx)  -- sends message, browser time zone, focus, last 3 questions
  -> askBroko (app/(app)/chat/actions.ts)         server action: requireUser, unlock gate, builds deps
  -> handleChat (lib/chat-service.ts)             builds BrainChatContext, audit write (metadata only)
  -> askBrain (lib/ai-brain/chat/brain.ts)        ONE deterministic pipeline:
       routeIntent (intent.ts, regex)  -> blocked / action_request / help decided on the typed text
       [Interpreter: Claude restates the message as one clear question]   (chat/interpreter.ts, new, uncommitted)
       tryMeeting (focus follow-ups) -> tryPrecon -> tryKnowledge -> tryMeeting -> tryNotion
       [ChatRouter: Claude picks a read-only intent for unsupported sentences]  (model-router.ts)
       answer(): deterministic retrieval + wording (retrieval.ts adapters)
  -> Tool Registry (assistant/tools.ts: ToolRegistry, runTool; brain-tools.ts: runBrainTool)
  -> connectors (assistant/connectors.ts, notion.ts, integrations/scoped-notion.ts) and user-scoped repo adapters
  -> Supabase (RLS) or demo backend
Claude is called from three places, all through one transport (classifier.ts anthropicTransport, model-transport.ts):
  Interpreter (language), ChatRouter (intent), Synthesizer (analysis of ONE meeting, claim-by-claim validated in meetings/analysis.ts),
  plus the email classifier (AI Inbox, separate).
```

## Answers to the 12 questions

1. **How is Claude integrated?** `anthropicTransport` in `src/lib/ai-brain/classifier.ts:199` posts to `/v1/messages` with `system` plus ONE user message. `createModelTransport` (`model-transport.ts`) is the single factory (one key, one `BROKO_AI_MODEL`). Per-purpose budgets and cooldowns: `model-router.ts`, `synthesizer.ts`, `interpreter.ts`, Redis limiter `redis-limiter.ts`. **IMPLEMENTED BUT NOT FULLY VERIFIED**: unit tests with fake transports; live runs exist only for the interpreter (41 cases, dev) and an earlier meeting synthesis. Timeouts are per call (default 30 s). There is no retry and no per-request token or cost budget across calls.
2. **Is Claude the primary reasoning engine?** No. **PARTIALLY IMPLEMENTED.** The primary engine is deterministic: regex routing (`intent.ts`, `meetings/request.ts`) and hand-written handlers choose the sources and write most wording. Claude is used for three narrow jobs: restating the question, choosing an intent for sentences the rules missed, and analyzing one already-selected meeting.
3. **Can Claude interpret intent and orchestrate multiple tools?** It interprets (Interpreter, **INV**). It does not orchestrate. No call anywhere sends a `tools` array or handles `tool_use` (grep of `src/` finds only the one `/v1/messages` call, with no tools parameter). **NOT IMPLEMENTED.**
4. **Can Claude request multiple tools through the Registry?** The Registry can run any registered tool (`runTool` validates, checks role, applies timeout, validates output, flags injection; writes always refuse `approval_required`). **IV** at the unit level (`tests/assistant-phase1.test.ts`, `assistant-registry-integration.test.ts`). But only Brain code calls it, with fixed sequences. Claude cannot call it. **NOT IMPLEMENTED** for model-driven calls. 21 contracts exist: Broko tasks, activity, notifications, AI inbox status, integrations, knowledge, Notion (pages, databases, meetings find/read), Outlook mail and calendar, plus refusing write contracts.
5. **Conversation context?** **PARTIALLY IMPLEMENTED, and verified in dev only.** Stateless server. The browser sends a validated `ChatFocus` (current meeting, last output type, topics; re-authorized by a fresh admin-only search, `chat/focus.ts`) and the last 3 user questions. No assistant turns, no list items ("the second action") and no non-meeting focus. Tests: `tests/conversation.test.ts`, `nl-understanding.test.ts`.
6. **Organizational memory?** **PARTIALLY IMPLEMENTED.** Approved Knowledge is retrievable (`chat/knowledge.ts`, ranking `lib/knowledge/search.ts`: keyword matching, no embeddings). Meetings are re-read from Notion on each question (cached 10 min per process in `meeting-cache.ts`). Nothing is remembered between questions beyond the above. There is no index of past meetings, so "did we discuss this before" works only through live Notion search.
7. **L0 / L1 / L2.**
   - L0: Notion is read live and not preserved (`notion.meetings.read` returns numbered segments; nothing stored). Precon documents and chunks are stored (`0007`, applied to broko-dev, history row only). Email/Teams/Outlook: **NOT IMPLEMENTED** (connectors are `unavailableConnectors()` stubs, no Graph code in `src`). Overall **PARTIALLY IMPLEMENTED**.
   - L1: Meeting analysis (summary, decisions, action items with refs) is computed per request and thrown away (cache only). The AI Inbox pipeline extracts email analysis, but its tables (`0003`, `0004`) are **not applied** and the real backend shows "not connected". **PARTIALLY IMPLEMENTED, nothing persisted.**
   - L2: Knowledge governance. `0009` tables `knowledge_items`, `knowledge_events`, `answer_feedback`; lifecycle proposed/approved/rejected/expired/superseded; admin-only approval; replacement guard (`0011`), secret check (`0012`); conflicts and stale labels in the Brain. Applied to broko-dev; live-tested on broko-dev except D4, D5, D6, D8 per `MIGRATION_STATUS.md`. **IMPLEMENTED AND VERIFIED on dev, not on production.** Not implemented: second reviewer (D6), retention (D5). The Brain never auto-promotes Notion content (**IV**, by design).
8. **Entities and relationships?** **NOT IMPLEMENTED.** There is no people, project, decision, commitment or relationship table. Meeting analysis returns owners and deadlines as quoted text. The only linkage is `precon_projects` (documents, chunks, inventory) and `knowledge_items.project_id`/`topic`.
9. **Reason across multiple authorized sources?** **PARTIALLY IMPLEMENTED.** Tasks + activity + notifications + knowledge are combined for dashboard questions (`retrieve()` with a dependency order). Meetings, Notion, Precon and Knowledge are handled by separate handlers; the first match answers. "Status of the marketing launch" cannot combine a Notion page, a meeting, tasks and Knowledge in one answer.
10. **Evidence, citations, provenance validation?** Strong for meetings: every claim needs segment refs; unsupported claims are removed and a mostly unsupported analysis is replaced by the deterministic view (`meetings/analysis.ts`, `tests/meetings-analysis.test.ts`) **IV (unit)**. Every tool record has system, record id, URL, retrieved_at, injection flag (`SourceRecordSchema`). Knowledge answers carry approval/review metadata. There is no generic post-generation check for answers outside meeting analysis (they are deterministic text, so no model claim to validate). The Interpreter's output is not evidence and is never shown.
11. **Are guardrails enforced in the Claude path?** Yes for the three present uses: Claude holds no data, identity, tool or credential; blocked and action requests are decided on the typed text before any model call; restatements that become blocked are dropped; the unlock gate and per-user budgets fail closed in production; chat audit stores metadata only (`0008`, live-tested 35/35 per owner). **INV.** For a tool-use loop these guardrails would need to be re-applied per call (see section C); that is not built.
12. **What is missing?** See section B.

## B. Gap analysis

| Vision requirement | State |
| --- | --- |
| Claude as language understanding | **PI/INV**: Interpreter built, 41/41 live in dev; not used in production, not browser-verified |
| Claude as reasoning and tool orchestrator | **NI** (deterministic handlers decide) |
| Multiple tools per question, follow-up retrieval | **NI** |
| Conversation memory incl. "the second action", non-meeting topics | **PI** |
| Org memory across past meetings / "did we discuss this before" | **PI** (live Notion search only; no stored index) |
| Outlook, Teams, Calendar connectors | **NI** (contracts and stubs only); Graph consent and token storage are unbuilt |
| Connection framework (personal vs shared, revocation) | **PI**: Phase A contracts, flag `BROKO_CONNECTION_FRAMEWORK`, frozen; no token store or OAuth |
| L0 raw store with provenance | **PI** (Precon only) |
| L1 extracted decisions/actions/commitments with evidence | **PI** (computed per request, not stored) |
| L2 governed knowledge | **IV (dev)** |
| Entity and relationship layer | **NI** |
| Cross-source evidence validation | **PI** (meetings only) |
| Central token/cost/timeout/retry control | **PI** (per-purpose budgets, no global ceiling or retry) |
| Production readiness | Deploy target, durable Redis, `BROKO_TIMEZONE`, and production DB state are open |

## C. Target architecture (incremental)

```
Employee message
 -> BrokoChat / askBroko / handleChat                      (unchanged)
 -> askBrain
     1. blocked/action/help decided on typed text           (unchanged, before any model)
     2. Claude "planner" turn (SAME transport, SAME budgets): given message, focus, history,
        and the Registry's READ-ONLY tool list (names, descriptions, zod input schemas)
        -> returns tool calls (Anthropic tool_use) or a clarification
     3. Each requested call runs ONLY through runTool(): role check, input validation, timeout,
        output validation, injection flag; write/prepare tools are not offered. User identity comes
        from the session, never from Claude. Max N calls, 1 or 2 rounds.
     4. Claude analysis turn over the returned records (untrusted data, fenced) -> answer with refs
     5. Evidence validator (generalize meetings/analysis.ts): every cited ref must exist in the tool
        results; unsupported claims removed; otherwise fall back to today's deterministic handlers
 -> reply (+ sources, honest data label, audit metadata only)
Deterministic handlers remain as the fallback and as the safety net; the planner is an additive path behind a flag.
L1: persist validated extractions (decisions, actions, commitments) with source refs as CANDIDATES in existing tables; no auto-promotion to L2.
Relationships: first model them as foreign keys / link rows on Postgres (meeting_ref, project_id, owner), not a graph database.
```
The existing Registry is already the right seam: contracts carry input schemas, access class, role requirement and provenance, so they map directly to Claude tool definitions. No new service, LLM provider, or database is required for steps 2–5.

## D. Phased roadmap (smallest steps first; each needs your approval before starting)

0. **Close current work.** Verify the Interpreter in the browser, commit decisions, deploy prerequisites (Redis, timezone env). No new design.
1. **Single-source tool use behind a flag** (`BROKO_CHAT_TOOL_USE`, default off). Transport gains a `tools` parameter and a bounded loop (max 3 calls, hard timeout, token cap). Offer only read tools the user's role may run. Fallback to the current pipeline on any failure. Offline tests with scripted tool_use; live eval reusing the 41 cases.
2. **Multi-tool questions.** Allow two or three tools per question (tasks + knowledge + Notion meetings), generic evidence validator that checks cited record ids against tool results.
3. **Better conversation state.** Store the last answer's structured items (numbered actions, decisions) in the focus so "the second action" resolves; extend focus beyond meetings. Still browser-held and re-authorized.
4. **Persist L1 candidates** (needs a migration, so your approval and a design first): extracted decisions/actions/commitments with source ref, extractor model, timestamp, status `candidate`; a review path into the existing Knowledge approval flow. Never auto-promote.
5. **Relationship links** on those tables (meeting, project, owner, task) using ordinary foreign keys. Revisit a graph only if joins prove insufficient.
6. **Outlook / Calendar / Teams** once the connection framework is unfrozen: token store, OAuth, resource registration, revocation, then read-only connectors behind existing contracts. This is the largest and most security-sensitive phase and should not start before 1–3 are stable.
7. Leadership summaries, change monitoring, drafts for approval: built on the same path, no separate agents.

## E. Risks and dependencies

- **Security:** a tool-use loop widens the model's influence. Mitigations are already designed: Registry-only access, identity from session, read-only tool list, fenced untrusted data, injection flag, no write tools offered, validator, fail closed. Residual risk: indirect prompt injection steering which tools are called; limit call count and never let tool output change the tool list. Admin-only meeting tools stay admin-only (Notion integration sees the shared workspace, not per-user access).
- **Data access:** personal vs shared connections are unresolved until the framework ships; connecting one account must not expose others. Notion remains an organization-wide token, hence admin-only.
- **Cost and latency:** planner + analysis turns add 2–6 s and several times today's tokens. Needs a global per-user/day budget, a cap on tokens per request, and Redis in production (in-memory limiters reset per instance).
- **Correctness:** an LLM planner can pick the wrong tool or over-claim. Keep the evidence validator and the deterministic fallback, and measure with the 41-case set plus multi-source cases before enabling.
- **Database:** L1/relationship storage needs migrations (approval needed). Production state is unknown; `0003`-`0005` are unapplied; several live checks are outstanding (`MIGRATION_STATUS.md`).
- **Process:** a large uncommitted tree (~78 entries) is the main delivery risk. Commit and review decisions are yours.
- **Dependencies:** Anthropic API availability and quota; Upstash Redis; deploy target (Vercel function duration for multi-turn calls); Microsoft Entra app registration for Outlook/Teams.

## Decisions requested

1. Approve phase 1 (flagged tool-use path through the existing Registry)? 
2. Should the first multi-source scenario be "status of project X" (Notion + meetings + tasks + Knowledge)?
3. OK to defer persistence (L1) and Outlook/Teams until phases 1–3 are measured?
