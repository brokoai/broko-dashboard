# Phase 2A — Persistent Organizational Brain: completion report

Branch: `feature/phase2a-org-brain` (created from the working tree's HEAD; all earlier uncommitted work preserved, nothing reset, stashed or cleaned).
Nothing is committed, pushed, merged or deployed. No migration was applied and no database was written. No dashboard UI file was touched. No env file was modified.

## 1. What this is

Three layers, one existing Brain:

| Layer | What it holds | Where it lives |
|---|---|---|
| **L0** source memory | an authorized Notion page exactly as read: normalized content, numbered evidence segments, content hash, edit time, ingest time, sync state, access scope | `src/lib/ai-brain/org-memory/` (+ `supabase/proposed/0013`) |
| **L1** extracted entities | people, teams, projects, meetings, decisions, tasks, action items, commitments, deadlines, risks, blockers, client requirements; each with evidence segment refs | same |
| **L2** approved knowledge | the **existing** Knowledge Base and its approval workflow | `src/lib/knowledge/*` — unchanged |

L1 is **proposed intelligence**. Nothing in Phase 2A approves anything. A reviewed L1 record can be *proposed* to the Knowledge Base (it arrives there as a `proposed` item, like a person's own submission); an administrator then approves or rejects it through the existing workflow.

## 2. Architecture

```
Notion (existing NotionConnector, read-only, org-wide integration)
  └─ discovery  findMeetingCandidates([], 100)          ← the connector pages through Notion itself
      └─ skip if the source's edit time equals the stored one   (incremental, no fetch)
      └─ fetch  readMeetingDocument(id)                  ← existing connector, segments S1..Sn, coverage
          └─ normalize + sanitize (flag instruction-like segments; they stay data, never model input)
              └─ L0 persist  upsertDoc → created | changed | unchanged   (content-hash compare, idempotent)
                  └─ extract  Anthropic tool transport, forced tool `record_entities`   (existing key/model/transport)
                      └─ validate  (deterministic code decides what is kept)
                          └─ L1 persist  upsertEntities → created | updated | unchanged | staled
                              └─ human review  approve / reject / accept_revision / dismiss_revision   (administrators)
                                  └─ optional L2  proposeToKnowledge → PROPOSED Knowledge item
Claude Brain ── Tool Registry ── memory.entities.find / memory.sources.read ── OrgMemoryReader (admin-only)
```

The path `BrokoChat → askBroko → handleChat → askBrain → Tool Registry` is preserved; there is no second Brain or chatbot.

### Rules enforced in code (not in the prompt)

* **Evidence is real**: every entity cites segment ids; each must exist in the stored document and must not be a flagged segment, or the entity is dropped.
* **No invented owners, teams or dates**: an owner/team/due value survives only if it literally appears in the segments the entity cites. Otherwise the field is emptied, listed under `unknowns` and counted (`owners_dropped`, `dates_dropped`).
* **A person/team entity** is kept only if the source names it.
* **Inference is labelled**: `basis` is `explicit | extracted | inferred | unknown`; an inference or unknown can never be `high` confidence; `unknown` carries no owner/date (also a SQL CHECK).
* **Injection**: flagged segments are never sent to the extractor or the answering model; entity names/descriptions that look like instructions are rejected.
* **Reviewed records are never overwritten**. If a re-extraction differs, the record is marked `stale` and the new values wait in `pending_revision`; only an administrator's `accept_revision` applies them (history kept). A rejected record is never brought back. Records a source no longer states, or whose source was archived, are marked stale, never deleted.
* **Failures are fixed codes** (`not_connected | permission_denied | rate_limited | timeout | error`), never raw errors or source text. Failed sources are retried up to a limit (default 5), then left visible as failed for a person.

## 3. Authorization

The Notion integration sees what was shared with Broko as a whole, not what each employee could open, so employee-level source permissions cannot be established. Memory derived from it is therefore **administrator-only** (`access_scope = 'admin'`), the same decision already made for the meeting tools.

* Registry: both memory tools are `requires: "admin"` → a member gets `permission_denied` before anything is read.
* Reader: `OrgMemoryReader` independently returns nothing / null / throws for a member, an unknown role and no user (so a role-check bypass still reads nothing — tested).
* Tool agent: a member is offered no tool and no model call is made.
* SQL: RLS `select` for `is_admin()` only; no API role (service_role included) holds INSERT/UPDATE/DELETE/TRUNCATE; every write goes through `SECURITY DEFINER` functions that check `is_admin()` against `auth.uid()`.
* Tokens: no credential is stored or returned anywhere in this module; tool output goes through the Registry's existing sanitising.

## 4. Files

New (all untracked, nothing committed):

* `src/lib/ai-brain/org-memory/{types,memory-repo,validate,extract,ingest,promote,index}.ts`
* `src/lib/ai-brain/assistant/memory-tools.ts` — the two Registry contracts
* `supabase/proposed/0013_org_memory.proposed.sql` and `supabase/proposed/tests/0013_org_memory.pglite.mjs`
* `tests/org-memory.test.ts` (40 tests), `tests/live/org-memory.live-dev.script.ts`
* this document

> **Note on excluded historical live scripts (added before the consolidated commit).** This document cites two older live scripts as verification evidence: `tests/live/org-memory.live-dev.script.ts` (section 8, real-source read-only run) and `tests/live/org-memory-e2e.live-dev.script.ts` (section 9, live end-to-end run). The results recorded here came from running them, and those results are kept unchanged as historical evidence. **Both scripts are intentionally excluded from this consolidated commit** and remain only in the author's working tree, unstaged. The current live verification script is `tests/live/org-memory-supabase.live-dev.script.ts`, which is in the commit. Do not read a missing script as a missing result.

Modified (Phase 2A changes only; these files also carry the earlier uncommitted Phase 1 work):

* `src/lib/ai-brain/assistant/tools.ts` — `SourceSystem` / `SourceRecordSchema` gain `"broko_memory"`
* `src/lib/ai-brain/assistant/brain-tools.ts` — `standardRegistry()` = Phase 1 contracts + memory contracts (`phase1Tools()` itself is unchanged)
* `src/lib/ai-brain/assistant/index.ts` — exports
* `src/lib/ai-brain/chat/types.ts` — optional `BrainChatContext.orgMemory`
* `src/lib/ai-brain/chat/tool-agent.ts` — memory tools allowlisted (admin only), memory prompt appended only when offered, evidence delivery for memory records, separate document budget (5)
* `src/lib/ai-brain/chat/brain.ts` — heading for memory-sourced answers

## 5. Schema (proposed, NOT applied)

`0013_org_memory.proposed.sql`: tables `org_source_docs`, `org_entities`, `org_entity_events`; functions `org_memory_upsert_doc`, `_record_failure`, `_archive_doc`, `_mark_extracted`, `_upsert_entity`, `_stale_missing`, `_review`, `_mark_promotion`; RLS + privileges as in §3. Depends on 0001 and 0009. Verified **only** on local PGlite (43/43 checks): created/unchanged/changed documents, fixed failure vocabulary and counter, proposed→reviewed, reviewed record not overwritten (staled with a pending revision), revision accept, rejection sticks, stale-missing, promotion goes through a *proposed* Knowledge item and never approves it, member/anon/service_role denied everywhere, history not directly writable. Rollback is in the file header.

## 6. Tools / API surface

| Tool | Access | Role | Returns |
|---|---|---|---|
| `memory.entities.find` `{entity_type?, query?, limit}` | read | admin | records (title, description, review state, owner/team/due only if stated) + provenance (page title/link) |
| `memory.sources.read` `{id}` | read | admin | one stored page as numbered segments |

Both are offered to Claude only through the existing tool agent. Records are delivered **with the evidence segments they cite**, labelled `M#.S#`; the existing all-or-nothing citation validation applies unchanged: an answer citing anything that was not delivered is declined whole. A record whose source changed since review (`source_changed`) delivers no citable segment. The prompt tells the model to say "proposed, not yet reviewed" and never to fill an unknown owner/date. There is **no write tool** for memory.

Server-side (not reachable from chat): `runIngestion(deps, opts)`, `createAnthropicExtractor`, `proposeToKnowledge`, `createMemoryOrgStore`.

## 7. Tests and results

* `npx tsc --noEmit`: 0 errors. `npx eslint .`: 0 findings.
* Full suite (`npm test`): **1328 pass, 0 fail** (includes the 40 new tests and all 90 Phase 1 tool-agent tests unchanged: Phase 1 regression clean).
* `node supabase/proposed/tests/0013_org_memory.pglite.mjs`: 43/43.
* `tests/org-memory.test.ts` covers: L0 fields; idempotent second run (byte-identical state, no re-read, no re-extract); hash-based duplicate detection when only the edit time moved; changed content → replace + re-extract; budgeted pagination (newest first, each page read once); failed ingestion (fixed code, no content), retry, recovery, attempt limit; discovery failure (no throw, nothing archived, store untouched); archive on a complete listing and *not* on a full (possibly truncated) one; extraction validation (non-existent evidence, flagged evidence, invented owner, invented date, unnamed person, inference confidence, malformed/extra-field/duplicate/injection-like, cap); extractor transport (forced tool, fenced data, flagged segments withheld, failure → recorded and retried); review lifecycle, revision accept/dismiss, rejection sticks, stale-missing; promotion (proposed only, once, refused when unreviewed/unavailable/non-admin); authorization (reader, Registry, bypass attempt, not-connected, no write tools); Brain integration (citation accepted only if delivered, undelivered citation declines whole answer, stale record not citable, member offered nothing, end-to-end through `askBrain`).

## 8. Real-source verification

`node --env-file=.env.local --conditions=react-server --import tsx tests/live/org-memory.live-dev.script.ts` — read-only against the real Notion workspace and the real model; in-memory store; **counts printed only** (no titles, text, ids or token).

*(Historical evidence. This script is intentionally excluded from the consolidated commit; see the note at the end of section 4.)*

* Discovery found 12 pages; 3 ingested (budget 3): 3 stored, 3/3 synced, 1585 segments, 0 flagged, 3 content hashes.
* Extraction: 3/3 documents, **85 records** (explicit 79, extracted 6), 1 rejected by validation; types: action_item 21, task 20, decision 17, risk 9, project 7, meeting 4, deadline 3, blocker 2, commitment 1, client_requirement 1.
* Every evidence ref exists in its stored source (and is unflagged): **true**. 31 records carry an owner and **every owner appears in its cited segments**; the validator dropped 1 unsupported owner and 4 unsupported dates; 53 records declare an unknown owner rather than guessing. All records are `proposed`.
* Idempotency on real content (same 3 pages re-read): 0 created, 0 changed, 3 unchanged by hash, nothing re-extracted, stored state identical.
* Authorization: a member's reader sees 0 records, an administrator's sees 50 (the page limit).
* A first run with a 4000-token extraction budget lost 1 of 3 documents to a truncated answer; the budget is now 8000 and the failed one would also have been retried automatically on the next run.

Not done live: a real-model *question* answered from memory (the agent path is tested with a scripted model only), and any run against a real Supabase.

## 9. Completion pass (2026-11-05): persistence adapter, controlled ingestion, live chat wiring

Added on top of sections 1-8:

* **Supabase adapter** `src/lib/backend/supabase/org-memory.ts` implements `OrgMemoryReader`/`OrgMemoryWriter` and the run lock over the 0013 functions. It runs as the SIGNED-IN USER's session (never `service_role`; the app has no service-role use at all), writes only through the definer functions (no table insert/update/delete), refuses non-administrators before any call, names explicit columns, excludes archived sources, caps page sizes, sanitises search text, normalises timestamps so they compare equal to the connector's, and maps errors to fixed messages (no source text). Attached as `Repo.orgMemory` by the Supabase backend; the demo has none.
* **0013 extended** with `org_ingest_runs` (partial unique index = one unfinished run at a time, abandoned after 15 min, counts-only report) and `org_memory_run_start/finish`. PGlite: 53/53.
* **Controlled ingestion path**: `src/lib/org-memory-service.ts` (`handleIngest`) + `POST /api/org-memory/ingest`. Server-validated administrator only; Supabase backend only; custom header required (a cross-site form cannot send it without a CORS preflight the route never answers); one run at a time; bounded (25 pages fetched, 10 extracted, 5 retries); idempotent; the outcome (counts and fixed codes) is stored with the run. Not a scheduler, no UI.
* **Live chat wiring**: `handleChat` now passes `repo.orgMemory.reader` (the signed-in user's own repository) as `BrainChatContext.orgMemory`. Path: `askBroko -> handleChat -> askBrain -> tool agent -> Registry -> memory repository`. Contracts of `memory.entities.find`/`memory.sources.read` are unchanged; Phase 1 tools untouched.

### Privilege investigation
The app never uses `service_role` (no occurrence under `src/`), and 0013 grants it nothing, consistent with 0009. 0013 therefore needs no extra grant: `authenticated` gets `SELECT` (RLS: administrators only) and `EXECUTE` on the definer functions (each re-checks `is_admin()` against `auth.uid()`); `anon`/`service_role`/`public` get nothing. Ingestion runs as an administrator's session. **A scheduled/unattended job cannot be supported by this model** and would need a separate, owner-approved decision (e.g. a dedicated narrowly-scoped role); none was invented.

### Tests (this pass)
`npx tsc --noEmit` 0 errors; `npx eslint .` 0; `npm test` **1350 pass / 0 fail**; `0013_org_memory.pglite.mjs` 53/53; `0009_knowledge.pglite.mjs` 122/122 (unchanged, still green). New: `tests/org-memory-service.test.ts` (15: admin path, member/anon/demo/no-Notion/no-repo refusal, role from the profile, concurrent run refused as busy, idempotent repeat, partial/failed runs, crash leaks nothing, chat wiring, citation accept/reject, member offered nothing, direct tool call by a member, guessed/malformed ids, memory unavailable, Phase 1 tools intact) and `tests/org-memory-supabase-contract.test.ts` (7: fail-closed for non-admins with zero database calls, function-only writes, normalisation/hash/stable ids, explicit columns/archived/rejected/limits/search sanitising, unextracted lookup, error mapping, busy slot).

### Live end-to-end (real Claude, real Notion, real chat orchestration)
`tests/live/org-memory-e2e.live-dev.script.ts`: ingestion via `handleIngest` (3 pages, 3 hashes, 82 records, all proposed, 1 rejected, 4 dates dropped) -> `handleChat` with the production `chatToolAgent()` resolver -> Claude chose `memory_entities_find` (repository reads: find + 2 document reads, 5.3 s) -> answered from the retrieved records, labelled "proposed, not yet reviewed", saying the notes do not state the owner -> 2 citations, all existing in the stored source -> the same question as a member: 0 repository reads, nothing leaked. **Caveat: the database in this run was the in-memory reference store**, because 0013 is not applied. It proves the application path, not durable persistence.

*(Historical evidence. This script is intentionally excluded from the consolidated commit; see the note at the end of section 4.)*

## 10. Remaining blockers / honest limits

> **Historical (written 2026-11-05) and SUPERSEDED where it describes migration 0013 as proposed and not applied.** Migration 0013 was applied to **broko-dev only** on 2026-11-05 (section 11 below) and its read-only catalog audit later passed 18 / 18 (section 12). The current migration status is section 11 of this document and `docs/MIGRATION_STATUS.md`. The same applies to the section 5 heading "Schema (proposed, NOT applied)" and to item 8 below ("no catalog-audit file for 0013"). The original wording is kept unchanged as the record of that date. Nothing here is production-applied.


1. **[HISTORICAL, SUPERSEDED by section 11] Migration 0013 is proposed, NOT applied (no migration was applied by this work).** Until it is approved and applied to a project, nothing is durable: the Supabase adapter has never run against a real database (verified only by the PGlite SQL tests and a stub contract test). After applying: run the adapter against that project with a real administrator session (ingest, restart the server, ask again) before calling Phase 2A done.
   Approval package: **SQL** `supabase/proposed/0013_org_memory.proposed.sql` (depends on 0001, 0009). **Objects**: tables `org_source_docs`, `org_entities`, `org_entity_events`, `org_ingest_runs`; unique `(provider, workspace_id, source_id)`, `(source_doc_id, stable_id)`, partial unique `org_ingest_runs_one_running`; 3 indexes; 11 `SECURITY DEFINER` functions with empty `search_path`. **Policies/grants**: RLS enabled on all four tables, `SELECT` for `is_admin()` only; `authenticated` gets `SELECT` on the tables and `EXECUTE` on the 10 public functions; `org_memory_guard` is internal; nothing to `anon`/`service_role`/`public`; no INSERT/UPDATE/DELETE/TRUNCATE for any API role. **Security implications**: all content is administrator-only; any administrator can read all ingested pages (Notion access is org-wide); ingestion runs under an administrator's session; page text is stored in Postgres (retention policy not defined; see `docs/RETENTION.md`). **Rollback**: drop statements in the file header (destroys stored sources, records and review history). **Tests completed**: 53 local PGlite checks.
2. **No scheduled ingestion** (see privilege note). An administrator must call the route; there is no button (UI was out of scope). Example: from a signed-in admin browser console, `fetch("/api/org-memory/ingest", {method: "POST", headers: {"x-broko-org-memory": "ingest"}})`.
3. `NOTION_WORKSPACE_ID` (optional, default `default`) is read by the route; `.env.example` was deliberately not edited.
4. The chat reaches memory only for sentences the deterministic router does not recognise, with `BROKO_AI_TOOLS=1`, `BROKO_AI_CHAT=llm`, a key and (in production) a durable limiter. Questions the rules recognise (e.g. "who owns ...") are answered by the existing handlers, not by memory.
5. Discovery reuses the meeting-oriented search (<=100 pages per run); a full 100 is treated as possibly truncated (nothing archived). Exhausted-retry sources need a person. No cross-document entity resolution; no L1 expiry (approved-knowledge expiry/supersession are the Knowledge workflow's).
6. Extraction quality is validated structurally, not against a human-labelled set. One answer was inspected by hand in the live run only.
7. No review UI (read/review via the repository API only).
8. SQL verified on PGlite only; no catalog-audit file for 0013.

## 11. Migration 0013 applied to broko-dev (2026-11-05)

Applied to **broko-dev only** (ref `olngcbgkxbceqpikcyxk`; confirmed by the CLI link, the project list and the migration history, which then read 0001, 0002, 0006-0013). Production was not touched. The apply used a temporary workdir outside the repo; `supabase/migrations` is unchanged. A dry run first showed 0013 as the only pending migration. The SQL was scanned: additive only (create table/index/function/policy, revoke/grant), no drop/delete/truncate and no change to an existing object.

Verified so far (anonymous, publishable key, read-only): the four tables exist and anon gets `42501 permission denied` on select and on insert; `org_memory_guard` and `org_memory_run_start` answer `42501` to anon; the other functions are not resolvable by anon (PostgREST 404). **Not yet verified on the real database** (needs an administrator and a member session, whose credentials were not available; `service_role` was not used and will not be): catalog audit of the 11 functions, policies and grants; adapter reads/writes; ingestion; idempotency; persistence after restart; the real-Claude chat answer from persisted records; member denial; run lock and lock expiry on the real database. These remain BLOCKED on credentials.

## 12. Verification status (updated 2026-11-12): NOT COMPLETE — latest live run (owner-reported) 28 PASS / 2 FAIL / 2 BLOCKED

### Latest live run (owner-reported; the assistant has not seen the results file)
| Result | Checks |
|---|---|
| **PASS (28)** | the earlier 25 plus **I3, I5 and K3**; K4 and the member/anonymous checks still pass. The history fix worked live. |
| **FAIL (2)** | **K1, K2**: the live chat returned the generic fixed-scope assistant reply, with zero repository reads and zero citations, instead of a memory answer. **Routing/retrieval defect, OUTSTANDING.** |
| **BLOCKED (2)** | **R3** (needs `--wait-expiry`, 15 real minutes) and **L2** (the safety guard refused: another account exists; `KNOWLEDGE_LIVE_ALLOW_OTHER_USERS` was not set) |

**K1/K2 root cause (code-derived and reproduced locally with a scripted model; not yet confirmed by a live trace):** all four K questions route the same way (`unsupported`, which makes them eligible for the tool agent), so intent routing is NOT the difference. K1/K2 ask "...the Halcyon warehouse slot". The stored record is named "Confirm warehouse slot" and described "Dana confirms the warehouse slot."; the word "Halcyon" appears only in the page title. Memory search (adapter AND in-memory twin) matches the whole query as ONE contiguous substring against name, description, owner and team, so a model query such as "Halcyon warehouse slot" returns 0 records ("warehouse slot" returns 1). With nothing delivered the model's "not found" answer has no citation, the tool agent declines it as `uncited`, and the ordinary path then returns the fixed-scope capabilities text. K3 passed partly because "who sends the halcyon checklist" matches the record "Send Halcyon checklist"; its budget question may also have been answered by the generic reply, so K3's "missing evidence disclosed" is weakly tested. **No fix is implemented yet (proposal pending approval).** The live script now prints a content-free trace (tool, redacted query, records returned, agent answered/declined code) so the next run confirms or refutes this.

### Previous live run (2026-11-11), kept for the record: 25 PASS / 5 FAIL / 2 BLOCKED

Nothing in this section is a pass unless it says PASS and names its evidence. Local, remote and owner-reported evidence are kept apart on purpose.

> **Correction.** An earlier version of this section (2026-11-11) said the live gates were blocked because the `PRECON_LIVE_*` variables were not set. That is **no longer true**: the owner ran the authenticated live script from their own terminal against broko-dev. The blockers now are the five failed and two blocked checks below.

### Live run (owner-executed, broko-dev, `tests/live/org-memory-supabase.live-dev.script.ts --execute`)
Run id `20261111162756-337202` (results file in the owner's `%TEMP%\broko-org-memory-live`, ids and statuses only). Two earlier attempts the same day stopped at A1 (target guard / configuration) before any write and are not counted.

| Result | Checks |
|---|---|
| **PASS (25)** | A1 A2 B1 B2 B3 B4 B5 B6 I1 I2 I4 R1 R2 R4 R5 R6 M1 M2 M3 M4 M5 K4 L1 L3 P1 |
| **FAIL (5)** | I3, I5, K1, K2, K3 |
| **BLOCKED (2)** | R3 (needs `--wait-expiry`: 15 real minutes), L2 (safety guard refused: 1 other account exists) |

The results file records statuses only, so the causes below come from reading the code and are **confirmed only by a rerun**.

| Check | Root cause (code-derived) | Fix (local, 2026-11-12) | Status |
|---|---|---|---|
| I3, I5 | The harness reads entities with `findEntities`, and the Supabase adapter returned `history: []` for every list read (history was loaded only by `getEntity`). Both checks assert `history.some(approve / accept_revision)`. The in-memory store always returned history, so local tests could not see the gap. | The adapter now loads review history for `findEntities` and `listReviewQueue` (and, for Phase 2B, relationship lists) with one batched `in(...)` query per list. Contract test `history is the same in lists and queues as in a single read`. | Fixed locally; **live rerun pending** |
| K1, K2 | The question asked about the Pune launch decision, which step I4 rejects on purpose; rejected records are never retrieved, so retrieval returned 0 records and there were no cites. | K1/K2 now ask about the warehouse slot, the record that survives as PROPOSED at that point. A test pins that the question never targets the rejected decision and that the warehouse record is not reviewed before K. | Fixed locally; **live rerun pending** |
| K3 | **Not determined.** Candidates: the invented-number regex matching the long run id that appears in page titles; or retrieval returning nothing for the phrase query. | The regex now ignores the run id. On any K failure the script prints sanitized diagnostics (shape, which sub-condition failed, records read, and a short excerpt with URLs, emails, tokens, ids and long numbers redacted; never credentials). `sanitizeDiag` is unit tested. | Diagnosed on the next run; **live rerun pending** |
| R3 | By design: lock expiry needs 15 real minutes. The run did not pass `--wait-expiry`. The SQL clock logic is proven on PGlite (53/53). | None needed. | **BLOCKED** until rerun with `--wait-expiry` |
| L2 | By design: the script refuses the approval step while another account could see the synthetic approved items. | **Unchanged.** The guard was not weakened (a test pins it). Needs the owner's decision: a clean project, or an explicit `KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=1` accepting that one other account may briefly see synthetic items. | **BLOCKED** until safely validated |

K4 passed (the member's chat read 0 records and showed no organizational content). Note K4 would also pass vacuously if admin retrieval were broken, so it does not substitute for K1-K3.

### Evidence by kind
| Evidence kind | Result |
|---|---|
| Local tests (`npm test`) | see the Phase 2B completion document for the current count; all pass |
| TypeScript / ESLint / production build | PASS / PASS / PASS |
| PGlite checks of migration 0013 | PASS 53/53 (controlled clock) |
| Catalog audit SQL against PGlite | PASS 18/18 rows (`0013_catalog_audit.proposed.sql`) |
| Remote catalog audit on broko-dev | **PASS (owner-reported, 2026-11-11)**: 18/18 rows `ok = true` (4/4 tables, 11/11 functions, 6/6 indexes, history 0013). Raw rows not seen by the assistant. |
| Authenticated live database tests | **PARTIAL**: latest owner-reported run 28 PASS / 2 FAIL (K1, K2) / 2 BLOCKED (R3, L2); previous run 25 / 5 / 2 |
| Real Claude retrieval over persisted Supabase rows | **FAIL (K1, K2) outstanding**; K3 and K4 pass (K3 weakly: see the K1/K2 note). Routing/retrieval fix awaiting approval |

### Acceptance criteria
| Criterion | Status |
|---|---|
| Remote migration / catalog audit | PASS (18/18, owner-reported) |
| Admin ingestion | PASS live (B1, B6) |
| Durable L0/L1 persistence | PASS live (B2, B3, B4, B5) |
| Idempotency | PASS live (I1, I2) |
| Changed-source revision lifecycle | **PASS live (I3, I4, I5; owner-reported)**: the list-history fix resolved the earlier I3/I5 failure |
| Run lock and recovery | PASS live for R1, R2, R4-R6; **R3 BLOCKED** (`--wait-expiry`) |
| Member authorization | PASS live (M1-M5, including anonymous denial) |
| No unauthorized data leakage | PASS live (M-group, K4) |
| Fresh-process durability | NOT YET RUN: needs the `--verify-persisted` step after a complete run (P1 only wrote the state file) *(update 2026-11-13: since run, PASS owner-reported; see "Fresh-process persistence verification" below)* |
| Real Claude retrieval from persisted rows | **FAIL (K1) outstanding**: routing/retrieval defect (whole-phrase substring search). K3, K4 pass |
| Valid citations and evidence | **FAIL (K2) outstanding**: no citation was produced because K1 retrieved nothing |
| Proposed/approved distinction | PASS live for L1, L3; **L2 BLOCKED** (approval step) |
| Existing Knowledge approval workflow | PARTIAL: L1, L3 PASS; L2 BLOCKED |
| Regression suite | PASS (local) |

**Phase 2A remains NOT COMPLETE.**

### Changes since the live run (2026-11-12) — local code, and one database change
* **E1 truncation fix (Phase 2A entity extraction, and Phase 2B relationships): COMPLETED locally.** Both extractors report `truncated` for a long page, but ingestion used to ignore it, and the "mark records the extraction no longer states as stale" step then staled every other record of that page, reviewed ones included. A truncated extraction now stores what it found and marks nothing stale (`reconcile: false`); the run report counts it as `reconcile_skipped_truncated`. Tests: `tests/org-extraction-truncation.test.ts` (9). Not exercised live.
* **Empty entity extraction no longer stales entities: COMPLETED locally.** The entity adapter and the in-memory twin never call or run `org_memory_stale_missing` for an empty or missing list (0013 untouched; its function would stale everything for an empty list). Tests: `tests/org-entity-empty-keep.test.ts` (8). Not exercised live.
* **Migration 0014 (Phase 2B) was applied to broko-dev ONLY on 2026-11-12 and its 18-row catalog audit passed 18 / 18.** This is a database-level result. **Live relationship behaviour remains UNVERIFIED**: no relationship has been extracted or stored, `BROKO_ORG_RELATIONSHIPS` is off, the relationship tables are empty, and the embed foreign-key names are confirmed in the catalog only. None of this changes any Phase 2A live result: the 25 PASS / 5 FAIL / 2 BLOCKED run above is unchanged and the rerun is still pending.
* Local totals now: `npm test` 1435 / 1435, `tsc` and `eslint` clean, `npm run build` succeeds.

### K-only live acceptance (2026-11-12, owner-executed on broko-dev): K1 and K2 PASS in run 20261112180412-d2ae4c
A dedicated `--k-only` mode of `tests/live/org-memory-supabase.live-dev.script.ts` runs only K1 and K2 against ONE synthetic source in its own workspace (`live-konly-<runId>`), as the admin, with real Claude through the existing Brain / Tool Registry, then archives that source. It took three live runs to get there; the two failures are kept here as the record.

| Run | Result | What the trace showed | Cause and fix |
|---|---|---|---|
| `20261112172003-a379af` | K1 FAIL, K2 FAIL (7 pass / 2 fail) | the model searched with `entity_type` decision, commitment and meeting; 0 records; the tool-call budget was spent; generic fallback reply | the stored record is a `task` and `entity_type` was a strict filter. Fixed locally: the type is now a hint (a typed search that finds nothing is repeated once without it, never after an error, and the result says so) and the memory prompt tells the model to leave the type out unless the user names one |
| `20261112175638-76e779` | K1 FAIL, K2 FAIL (7 pass / 2 fail) | the search now returned the record (1 row) with the correct segment delivered (`M1.S2`); the model's final answer had 3 items, one factual item with no citation; `declined:uncited`; generic fallback reply | validation is all-or-nothing and one uncited factual item (the review status or an absence claim, which have no segment to cite) discarded the cited item too. Fixed by a prompt-only correction to `MEMORY_PROMPT`: status inside the cited sentence, absence only in the coverage form, one factual sentence per cited item. `finalizeItems` and every validation rule are unchanged |
| **`20261112180412-d2ae4c`** | **K1 PASS, K2 PASS (9 pass / 0 fail)** | see below | the prompt-only correction worked for this run |

**Run `20261112180412-d2ae4c` (the passing run):**
* Summary: 9 passed, 0 failed (A1, KA1, KA2, KB1, KB2, K1, K2, KC1, KC2). Results file: `%TEMP%\broko-org-memory-live\20261112180412-d2ae4c.results.jsonl`.
* Model: `claude-haiku-5-5` (unchanged; no model change was made).
* Retrieval: query "Halcyon warehouse slot" with no `entity_type` returned 1 record; a second search "Halcyon" returned 0; 2 repository records read in total.
* Citations: 1 valid distinct citation, `M1.S2` (the expected evidence segment, delivered to the model); the final answer had 3 items (two cited with `M1.S2`, one non-factual coverage item); the predicted validation branch (`none`) matched the agent's real outcome (`answered`). The answer states the record's status (proposed, not yet reviewed) inside the cited sentence and states no number or amount.
* Cleanup (KC1): the run's single source was archived and verified archived; the run lock was released.
* Isolation (KC2): the pre-existing rows are unchanged by fingerprint, before and after: 10 documents, 14 entities, 0 relationships, 46 Knowledge items.
* Residual synthetic rows: 3 (1 source, archived; 1 entity; 1 ingest-run row) in workspace `live-konly-20261112180412-d2ae4c`. They remain **archived and were NOT deleted**; removing them needs a separate approval. The two earlier K-only runs above left the same three rows each, also archived and not deleted.
* Local checks at that point: `npm test` 1511 / 1511, `tsc` and `eslint` clean, `npm run build` succeeds, PGlite 0013 53 / 53 and 0014 102 / 102.

**What this does and does not establish:**
* This is **one** successful live acceptance run. **Reliability across repeated runs is NOT established** (the model is not deterministic: the identical question and fixture failed on the previous run before the prompt correction).
* It covers K1/K2 for one synthetic record only. It says nothing about K3, K4, multi-record questions, R3, L2, fresh-process persistence or the route-restart test.
* **Phase 2A is NOT COMPLETE.**
* **Phase 2B is NOT production-ready and NOT live-verified.** The controlled relationship write test remains on hold and `BROKO_ORG_RELATIONSHIPS` stays off.

### K-only repeatability (2026-11-12): K1 2 / 3 PASS, K2 2 / 3 PASS — NOT reliably accepted
Three K-only live runs on broko-dev after the prompt-only citation correction (same script, same model `claude-haiku-5-5`, one synthetic source each; details of the baseline run are in the subsection above):

| Run | Run ID | K1 | K2 | Overall |
|---|---|---|---|---|
| Baseline K-only | `20261112180412-d2ae4c` | PASS | PASS | 9 / 9 |
| Repeat 2 | `20261112181921-daf5ff` | FAIL | FAIL | 7 / 9 |
| Repeat 3 | `20261112182109-a6ad16` | PASS | PASS | 9 / 9 |

* Aggregate: **K1 2 / 3**, **K2 2 / 3**, **combined 2 / 3 complete runs passed**. Three samples from a non-deterministic model are a very small sample; this is **not** a reliability measure.
* All three runs passed A1, KA1, KA2, KB1, KB2, KC1 and KC2 (guard, admin role, preflight, ingest, stored-record check, cleanup, isolation).
* No pre-existing record changed in any run (fingerprints identical before and after each run: 10 / 14 / 0 / 46, then 12 / 16 / 0 / 46, then 13 / 17 / 0 / 46 documents / entities / relationships / Knowledge items — the growth is the earlier runs' own archived synthetic rows).
* All three synthetic sources were archived. Each run left one archived source, one proposed entity and one ingest-run row; these residual rows were **not deleted**. No relationship or Knowledge record was created.
* Results files: `%TEMP%\broko-org-memory-live\<run id>.results.jsonl`.
* Note on the record: the assistant was given the output of these three runs (the baseline and the two repeats). No further run's output was provided to it.

**Failure observed in Repeat 2 (`20261112181921-daf5ff`)** — the stages are separated because only the fifth failed:
1. Retrieval: worked. Two parallel searches; "warehouse slot" returned the 1 expected record, "Halcyon" returned 0; `entity_type` omitted; 2 records read.
2. Evidence delivery: worked. Segment `M1.S2` was delivered to the model.
3. Claude's answer composition: **the inconsistency.** Claude submitted 3 items: item 1 (factual, cited `M1.S2`, valid), item 2 (non-factual, no cite), item 3 (98 characters, one factual sentence, **no citation**).
4. Citation validation: worked as designed. The all-or-nothing validator rejected the whole answer (`declined:uncited`, predicted branch `factual_item_without_cite (item 3)`, matching the agent's real outcome), so the valid cited item 1 was discarded with it.
5. Final answer acceptance: none; the generic fixed-scope fallback reply was shown.

**Why Repeat 3 passed:** repository reads 2, 1 valid citation (`M1.S2`), three items of which one was a cited factual sentence and two were non-factual coverage items; every factual item passed validation (`predicted_branch=none`, agent `answered`). No validator weakening was involved. The baseline run passed the same way.

**Proven:** retrieval and evidence delivery work (all three runs). **Not proven:** that Claude's answer composition is reliable. The text of the uncited item in Repeat 2 is not in the trace (it is content-free by design), so its cause is not established. See `docs/PHASE2A_K1K2_FIX_PROPOSAL.md`, "Three-Run Live Acceptance and Citation Reliability Findings", for the read-only code inspection and a proposed (unimplemented) remediation.

**K1/K2 are NOT reliably accepted and nothing here is production-ready. Phase 2A is NOT COMPLETE. Phase 2B is NOT production-ready and NOT live-verified.**

### K1/K2 status decision (2026-11-13): DEVELOPMENT COMPLETE; production acceptance DEFERRED to go-live
**Decision (owner):** K1 and K2 are considered **development-complete** for the current development phase. Live reliability and acceptance testing of K1/K2 is **deferred to the Production Go-Live / Acceptance Testing checklist** below. This is a scoping decision, not a reliability finding.

**Development complete means:** the code, prompt, diagnostics and local tests for K1/K2 are in place and verified locally, and the K-only live script has passed K1 and K2 on broko-dev. It does **not** mean the behaviour is reliable, accepted for production, or that Phase 2A is complete.

**Historical results (all four reported K-only runs on broko-dev, model `claude-haiku-5-5`, kept as recorded):**

| Run | Run ID | K1 | K2 | Overall |
|---|---|---|---|---|
| Baseline K-only | `20261112180412-d2ae4c` | PASS | PASS | 9 / 9 |
| Repeat 2 | `20261112181921-daf5ff` | FAIL | FAIL | 7 / 9 |
| Repeat 3 | `20261112182109-a6ad16` | PASS | PASS | 9 / 9 |
| Repeat 4 (with Step 0 diagnostics) | `20261112183114-35c060` | PASS | PASS | 9 / 9 |

* **Three successful complete runs and one failed run out of four** (K1 3 / 4, K2 3 / 4). Four samples from a non-deterministic model are not a reliability measure, and the intermittent failure is **not** resolved.
* The one failure (Repeat 2) was Claude's answer composition: one factual sentence submitted without a citation, which the all-or-nothing validator correctly rejected. Retrieval and evidence delivery worked in all four runs.
* Run 4 left the pre-existing rows unchanged by fingerprint (14 / 18 / 0 / 46 documents / entities / relationships / Knowledge items before and after) and archived its single synthetic source. Residual synthetic rows from all K-only runs are archived or proposed, hidden from retrieval and **not deleted**; removing them needs a separate approval.
* No `uncited_item` flags exist for any run: Step 0 was added after the failing runs, and Run 4 passed. The console trace was not persisted at the time (see below).

**What was retained for go-live validation (no change in this documentation pass):**
* The content-free trace in `tests/live/org-memory-supabase.live-dev.script.ts`: tool calls, search words, record counts, per-round submission breakdown, predicted validation branch, and (Step 0) `uncited_item{…}` category flags (length, bullet, negation, query term, review status, owner/team, due date, factual, zero cites). No answer, source or evidence text is recorded.
* Persistence of the K1/K2 diagnostic in the results JSONL as a separate `type:"detail"` line (allow-listed, `sanitizeDiag`-sanitized, 4000-character cap; the answer excerpt and labels are never kept). Runs made before this was added have no persisted detail.
* The local tests that pin all of the above (`tests/org-memory-live-script.test.ts`, `tests/org-memory-answer-form.test.ts`).

**The citation validator is unchanged and was not weakened.** `finalizeItems` stays all-or-nothing: a factual item needs a delivered, valid citation, one factual sentence per item, no marker in the text. Widening the coverage allowance or dropping uncited items instead of rejecting the answer remains **not recommended** without an explicit governance decision.

**Development completion is distinct from production acceptance.** Not proven and now owned by go-live acceptance: how often Claude composes a fully compliant answer, behaviour on anything other than one synthetic record, other models, and K3/K4 in the full script.

### Production Go-Live / Acceptance Testing checklist (K1/K2 items moved here)
Nothing below is done. None of it is authorized by this document; each live run needs the owner's explicit authorization and credentials come only from the owner's own PowerShell environment.
- [ ] **K1/K2 reliability:** repeated K-only runs (`--k-only`, dry-run first) against the go-live target with a pre-agreed sample size and pass-rate threshold (to be set by the owner at go-live). Inspect the persisted `detail` lines and any `uncited_item` flags of failing runs.
- [ ] If failures occur: choose a remediation with approval (prompt disclosure templates, deterministic disclosure built from record fields, or an explicit governance decision on the validator), then re-test. See `docs/PHASE2A_K1K2_FIX_PROPOSAL.md`.
- [ ] K3 and K4 in the full script (`--execute`) on the go-live target.
- [ ] R3 (`--wait-expiry`), L2 (owner decision on the other-account safeguard) and the route-restart test on a port other than 3200. (The fresh-process `--verify-persisted` check passed on 2026-11-13, owner-reported; its evidence-reference line was vacuous.)
- [ ] Decide on purging archived synthetic residual rows (separate approval).
- [ ] Phase 2B go-live acceptance (controlled relationship write test and the rest): see `docs/PHASE2B_GO_LIVE_ACCEPTANCE.md`; `BROKO_ORG_RELATIONSHIPS` stays off until its enablement criteria are met.

**Status:** K1/K2 **development-complete**; K1/K2 **production acceptance not done**. Phase 2A is **NOT COMPLETE** (outstanding items above). Phase 2B is **NOT production-ready and NOT live-verified**. Nothing is committed, pushed, merged or deployed.

### Phase 2B documentation status (2026-11-13)
Phase 2B (relationship intelligence) is **development-complete locally**: migration 0014 is applied to broko-dev only (catalog audit 18 / 18), the latest local run is `npm test` 1532 / 1532 with PGlite 53 / 53 and 102 / 102, and the read-only PostgREST smoke test passed 19 / 19 (owner-reported, empty tables). **Live relationship behaviour is not verified**, `BROKO_ORG_RELATIONSHIPS` is **off**, and production acceptance has not started. **Local development completion does not mean production acceptance.** The status summary is in `docs/PHASE2B_COMPLETION.md` and the acceptance checklist is `docs/PHASE2B_GO_LIVE_ACCEPTANCE.md`. The Phase 2A engineering gates (R3, L2, fresh-process check, route-restart test) come before any Phase 2B live step.


### Fresh-process persistence verification (2026-11-13): PASS, owner-reported
The owner ran `--verify-persisted` in a new process on 2026-11-13 against the state file of the latest full run, **`20261112120115-703b3b`** (the 2026-11-12 full run: 28 PASS / 2 FAIL / 2 BLOCKED, P1 PASS; unchanged). The step is read-only: it signs in as the admin, selects from the stored tables and counts records directly. It created and changed nothing. The assistant saw the three result lines below, not the full console, and ran nothing itself.

| Check | Result | What it establishes |
|---|---|---|
| L0 documents | **PASS (3 / 3)** | All three synthetic documents persisted; content hashes identical to the recorded ones; hashes valid (64 hex characters); extracted hash equals the current content hash. |
| L1 records | **PASS (5 / 5)** | All five extracted records are still in the database (counted directly, because the sources are archived). |
| Evidence references | **VACUOUS PASS** | The reader saw **0** records because the synthetic sources were archived and archived sources are hidden from retrieval by design, so there were no visible evidence references to inspect. This does **not** independently establish evidence integrity after a restart. It is **not** a substantive PASS. The applicable evidence-integrity result remains the original full-run live check **B4** (every evidence reference resolves to a stored segment, owner / team / due appear in the cited text). |

* **Durability** of the stored documents and records across a fresh process is therefore established for this run (checks 1 and 2). Evidence integrity after restart is **not** separately re-established.
* This does not change any earlier result, including the K1 / K2 failures of that same run (K1 / K2 are tracked separately above), and it is **not production acceptance**.

### Phase 2A gates: status after this entry (2026-11-13)
| Gate | Status |
|---|---|
| Fresh-process persistence (`--verify-persisted`) | **PASS, owner-reported** (this entry); evidence-reference check vacuous |
| R3: 15-minute lock expiry | **BLOCKED.** Needs separate approval: the run lock is the single global ingestion slot, so `--wait-expiry` (full `--execute` run only) holds it for about 15.5 minutes, and nothing here can confirm no other run is active |
| Route restart test on port 3300 | **BLOCKED.** The route ingests the signed-in admin's real Notion pages and runs real extraction, so a safe synthetic Notion test strategy is required first |
| L2 approval | **BLOCKED.** The safe multi-user approval strategy is unresolved; `KNOWLEDGE_LIVE_ALLOW_OTHER_USERS` is not set and no Knowledge record was approved |
| Phase 2B live acceptance | Separate checklist, **NOT STARTED**: `docs/PHASE2B_GO_LIVE_ACCEPTANCE.md` |

Phase 2A remains **NOT COMPLETE**; Phase 2B is NOT production-ready and NOT live-verified.

### To finish
* Outstanding before Phase 2A can be called complete: K1/K2 production acceptance (development-complete as of 2026-11-13; live reliability testing deferred to the go-live checklist above), R3 (rerun with `--wait-expiry`), L2 (owner decision on the other-account safeguard), and the route-restart check. Neither phase is production-ready.
0. Keep `BROKO_ORG_RELATIONSHIPS` unset (or 0) for every Phase 2A run and the route test. 0014 is now applied on broko-dev, but the flag stays off until the Phase 2A gates pass, so the rerun exercises exactly the Phase 2A behaviour.
1. Rerun the script from the owner's terminal (`--execute --wait-expiry`) so R3 can run; then the printed `--verify-persisted` command in a new process (the latter done 2026-11-13 for run `20261112120115-703b3b`: PASS, owner-reported). Expect I3, I5, K1, K2 to pass; K3 either passes or prints its sanitized diagnostics.
2. Decide how L2 is validated safely (clean project, or the explicit override), without weakening the guard.
3. Route-level check (not scripted): start the app on a port other than 3200 with the broko-dev URL and publishable key in that process only, sign in as the admin, POST the ingest route, restart the app and re-read.
4. Only if every row above is PASS: review the diff, stage only Phase 2A files, commit locally. Nothing is committed, pushed, merged or deployed.
