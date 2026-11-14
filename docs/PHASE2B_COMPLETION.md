# Phase 2B — Organizational relationships (local implementation)

**Status (2026-11-12): implemented and tested locally; migration 0014 is APPLIED to broko-dev ONLY (`olngcbgkxbceqpikcyxk`) and its 18-row database catalog audit passed 18/18. Live relationship behaviour is UNVERIFIED.** No relationship has been extracted, stored, reviewed or read through the app: the table is empty, `BROKO_ORG_RELATIONSHIPS` is off, no ingestion was run, and no real Claude relationship extraction has happened. Production was not touched. Phase 2A is still **NOT COMPLETE** (latest owner-reported live run 28 PASS / 2 FAIL / 2 BLOCKED; K1/K2 routing/retrieval defect outstanding, R3 and L2 blocked; see `docs/PHASE2A_COMPLETION.md` §12). The authenticated **PostgREST read-only smoke test PASSED 19 / 19 (owner-reported)**: the adapter's embedded selects resolve and member/anonymous reads are refused or empty on the empty tables. Relationship extraction, storage, review and row-level-security filtering with data are **UNVERIFIED live**. Neither phase is production-ready.

## Status summary (2026-11-13) — local development COMPLETE; live acceptance NOT started
**Local development completion is not production acceptance.** This section is the one place that states where Phase 2B stands; the sections below it are the detailed record and keep their dates.

| Area | Status |
|---|---|
| Local implementation | **Complete.** Extraction (all 12 relation types, explicit / extracted / inferred, E# endpoint refs, evidence validation), persistence through the guarded 0014 functions, `memory.relationships.find` in the existing Registry and tool agent, review workflow (approve, reject, accept / dismiss revision), stale and pending-revision handling, reviewed-link protection, history. Nothing is a second Brain, engine or Registry. |
| Database migration | `0014_org_relationships.proposed.sql` is **applied to broko-dev only** (`olngcbgkxbceqpikcyxk`, 2026-11-12, by the CLI). 18-row catalog audit 18 / 18. Not applied to production. Both relationship tables were empty when last checked. Migrations 0009, 0013 and 0014 are unmodified in this documentation pass (md5 `0d1f2878…`, `ee089cb1…`, `6335f12c…`). |
| Automated tests (latest local run, 2026-11-13) | `npm test` **1532 / 1532**; focused Phase 2B and extraction suites **82 / 82** (includes the new `tests/org-relationships-brain.test.ts`, 8 tests on what the model is shown per lifecycle state); PGlite 0013 **53 / 53**, 0014 **102 / 102**; `tsc --noEmit` and `eslint src tests --quiet` clean; `npm run build` succeeds. Local only: fixtures, an in-memory twin, a stub database client and scripted model transports. |
| Read-only live verification | Authenticated PostgREST read-only smoke test **19 / 19** (owner-reported; the embedded selects, both endpoint embeds, the document embed, the history query and the negative controls resolve; member reads empty and anonymous reads denied **on empty tables**). Database-level no-op function check on broko-dev (assistant-run, in one rolled-back transaction): admin review of an unknown id `P0002`, `stale_missing([])` returned 0, upsert with unknown endpoints `skipped`, member and anonymous calls `42501`, row counts unchanged. The owner has also reported that the authenticated no-op RPC check through PostgREST passed; the assistant has not seen that output, and this document's earlier record listed `--with-noop-rpc` as pending, so treat it as **owner-reported, unconfirmed here**. |
| NOT verified | Live relationship creation, extraction by real Claude, retrieval of persisted relationships through the app, review actions through the app, row-level-security **filtering with data present**, and anything on production. |
| Feature flag | `BROKO_ORG_RELATIONSHIPS` is **OFF** and was not changed. It gates the ingest route's extractor and the chat tool. |
| Known limitations | Same-document links only (cross-document resolution unsupported; the SQL refuses it); no review UI; "inferred" labelling is prompt-enforced only; name search matches endpoints only; adapter over-fetches 200 rows and filters in code; real extraction quality unmeasured; relationship answers share the all-or-nothing citation rule and the intermittent uncited-sentence risk seen in K1/K2. |
| Go-live acceptance | Separate checklist, not started: `docs/PHASE2B_GO_LIVE_ACCEPTANCE.md` (controlled synthetic creation, real extraction quality, retrieval against persisted records, evidence and citation validation, admin / member / anonymous RLS with data, approve / reject / revision workflows, reviewed-link protection, flag enablement criteria). Phase 2A engineering gates come first. |

**Phase 2B is NOT production-ready and NOT live-verified.**

### Applied and audited on broko-dev (2026-11-12, by the CLI `db push --linked`)
| Item | Result |
|---|---|
| Target | linked ref exactly `olngcbgkxbceqpikcyxk`; migration history showed 0001, 0002, 0006-0013 and no 0014 before; 0014 only after |
| Catalog audit `0014_catalog_audit.proposed.sql` | **18 / 18 rows `ok`** (2 tables with RLS and one admin-select policy each; 4 functions: security definer, empty search_path, owner postgres, no PUBLIC/anon/service_role execute, authenticated execute on the three public ones; both constraint sets exact; 5 foreign keys by exact name, target, column and ON DELETE; trigger; 6 indexes by name and definition; history row 0014) |
| Safeguards in the APPLIED functions | present: `org_relationship_stale_missing` returns 0 for a NULL or empty keep list; `org_relationship_review` refuses approving a stale relationship |
| Adapter embed hints | `org_relationships_from_entity_id_fkey` and `org_relationships_to_entity_id_fkey` exist in the catalog. **PostgREST resolution of the embeds is still unproven** (needs a real adapter call; the schema cache may need a reload) |
| Data | both tables empty; no records created, approved, rejected or modified |
| Local repo | the CLI refuses to push while local `supabase/migrations` lacks the remote versions, so identical copies of the proposed files were put there temporarily and removed afterwards; the folder again holds only `0001_init.sql`. Migrations 0009 and 0013 are byte-identical to before |

## What it adds

Typed links between entities that Phase 2A already extracted, stored in Postgres (no graph database, no second Brain, no second Registry, no new LLM provider).

| Piece | Where |
|---|---|
| Tables `org_relationships`, `org_relationship_events`, 4 functions, RLS | `supabase/proposed/0014_org_relationships.proposed.sql` |
| Read-only catalog audit (8 rows) | `supabase/proposed/tests/0014_catalog_audit.proposed.sql` |
| Local SQL test (PGlite, 51 checks) | `supabase/proposed/tests/0014_org_relationships.pglite.mjs` |
| Types, vocabulary | `src/lib/ai-brain/org-memory/types.ts` |
| Deterministic validation | `src/lib/ai-brain/org-memory/relationships.ts` |
| Model extraction (forced `record_relationships` tool, existing transport) | `src/lib/ai-brain/org-memory/extract-relationships.ts` |
| Ingestion step (after entities, same run) | `src/lib/ai-brain/org-memory/ingest.ts` |
| In-memory reference behaviour | `src/lib/ai-brain/org-memory/memory-repo.ts` |
| Supabase adapter | `src/lib/backend/supabase/org-memory.ts` |
| Registry tool `memory.relationships.find` | `src/lib/ai-brain/assistant/memory-tools.ts` |
| Chat evidence + prompt | `src/lib/ai-brain/chat/tool-agent.ts` |
| Service / route wiring | `src/lib/org-memory-service.ts`, `src/app/api/org-memory/ingest/route.ts` |
| Tests | `tests/org-relationships.test.ts` (22) plus updated tool-list assertions |

## Approved vocabulary (12)

OWNS, BELONGS_TO, PART_OF, RESULTED_IN, DISCUSSED_IN, BLOCKS, DEPENDS_ON, COMMITTED_TO, HAS_DEADLINE, ASSIGNED_TO, RELATES_TO, RAISED_IN. A test fails if the TypeScript list and the SQL check constraint ever differ. `TYPE_RULES` fixes which entity types each relation may connect (direction matters; RELATES_TO is the generic link).

## Rules (how the 12 requirements are met)

1. **Stable ids.** A link joins two existing entity ids. The model never writes names; it picks from a numbered list (`E1..En`), and the validator resolves them.
2. **Eligible endpoints.** Not rejected, source not archived, and not "stale with no waiting revision". Enforced in the validator, the SQL (`org_relationship_endpoint_ok`), the in-memory twin and the adapter.
3. **Resolvable evidence.** 1–8 segment ids of the source document, each present and not flagged as instruction-like; checked in the validator and again in SQL. Person/team endpoints must literally appear in the cited text.
4. **Basis, confidence, review status** are stored: `explicit | extracted | inferred`; `high | medium | low`; `proposed | reviewed | rejected`.
5. **Inferred is never silently verified.** Support decides basis: "explicit" needs the cited text to anchor both endpoints; "extracted" needs one; otherwise it is stored as `inferred` and counted (`relationships_downgraded`). An inference is capped below high confidence (DB check too), and **approving an inferred link needs a written reason**. Chat labels inferred links as the notes' implication, not fact.
6. **Reviewed links are never overwritten.** A different extraction sets `stale` + `pending_revision`; a person accepts or dismisses it.
7. **Lifecycle.** Stale (source no longer states it, or source archived), pending revision, reject (permanent: a rejected link is found again and stays rejected), approve, accept/dismiss revision; each review writes an event row.
8. **RLS and writes.** Admin-only select; no insert/update/delete grants; all writes through SECURITY DEFINER functions with `search_path=''` that call `org_memory_guard()`; the helper and guard are executable by nobody. Same shape as 0013. The adapter additionally refuses non-admins before any call.
9. **Registry.** `memory.relationships.find` (read-only, admin-only, `broko_memory`) joins the existing Brain/Registry; the tool agent's allowlist derives from `MEMORY_TOOLS`, so nothing else was opened.
10. **Reuse.** Same transport/key/model as entity extraction, same validation style, review semantics and adapter error mapping.
11. **No graph DB / second engine.**
12. **Notion Admin Integration untouched; migrations 0009 and 0013 untouched** (relationship extraction failure reuses 0013's existing `extraction_failed` document code).

## Behaviour notes

- Relationships are extracted in the same ingestion loop as entities. If the relationship step fails the document stays "unextracted" and is retried next run (entity upsert is idempotent; reviewed records are never overwritten). Run status becomes `partial`.
- A link whose source changed is listed but **never citable** in chat (no evidence segments delivered), same rule as entities.
- Deployed behaviour depends on the model returning the structured tool call; any other answer is a clean failure (counted, retried).


## Audit remediation (2026-11-12) — local only

| # | Defect found by the audit | Root cause | Fix now in place | Needs 0014 edit? |
|---|---|---|---|---|
| 6 | A stale PROPOSED relationship could be approved (confirmed on PGlite) | `org_relationship_review` did not check `stale` | Adapter refuses approve when the link is stale (before the RPC); in-memory twin throws. Reject / accept_revision unchanged. | Done in 0014 (approved 2026-11-12; still not applied remotely) |
| 7 | An empty or all-invalid extraction staled REVIEWED links (confirmed on PGlite) | `org_relationship_stale_missing` with an empty keep list stales everything | An empty relationship list calls no `stale_missing` (adapter) / stales nothing (twin). A non-empty partial list still stales the links no longer stated. | Done in 0014 (same) |
| 8 | List and queue reads returned `history: []` (the same gap that failed live checks I3 and I5 for entities) | History was loaded only by the single-record read | Entity find/queue and relationship find/queue load history with one batched `in()` query per list. | No |
| 9 | Only 2 of 12 types were exercised end to end | Tests covered the vocabulary, not each type | `tests/org-relationships-remediation.test.ts`: a hand-written valid and invalid endpoint pair for every type, through ingestion, validator, store lookup by type and the Registry tool; PGlite stores and de-duplicates every type. | No |
| 10 | Audit SQL did not cover constraints, FKs, trigger, owner, index definitions, PUBLIC execute, exact `search_path` | Too coarse | Audit expanded from 8 to 18 rows (exact constraint set by name and kind; vocabulary, evidence 1..8, not-self, inferred-never-high, unique-key order; 5 FKs by exact name, target, column and ON DELETE; trigger; owners; empty search_path; no PUBLIC execute; 6 indexes by definition). 12 mutation checks prove each category can fail. | No |

Items 6 and 7 are now also enforced by the 0014 SQL itself: verified on local PGlite, and the safeguards are present in the functions applied to broko-dev (catalog check only, never exercised through the app). The application-layer guards remain as defence in depth.

### Audit follow-up E1: truncated extraction must not stale anything (2026-11-12) — fixed locally
The audit found that both extractors report `truncated` when a long document exceeded the model input budget, but ingestion ignored it. The model then saw only the start of the page, and the "mark what the extraction no longer states as stale" step staled every other record or link of that document, reviewed ones included. This affected Phase 2A entity extraction and Phase 2B relationship extraction.

| Fix | Where |
|---|---|
| `truncated` now reaches the writer as `{ reconcile: false }` (entities and relationships judged separately); the stale-missing step is skipped, what was found is still stored, changed reviewed records still park as pending revisions, new records are still created | `ingest.ts`, `types.ts` (`UpsertOptions`), `memory-repo.ts`, `backend/supabase/org-memory.ts` |
| One count per document in the run report: `reconcile_skipped_truncated`. The document is still marked extracted (no endless retry) | `ingest.ts` |
| Regression tests: truncated and non-truncated, entities and relationships, reviewed records and pending revisions; with the fix broken 4 of 9 fail | `tests/org-extraction-truncation.test.ts` (9) |

### Audit follow-up: an empty entity extraction must not stale entities (2026-11-12) — fixed locally
`org_memory_stale_missing` (0013, untouched) stales every non-rejected entity of a document when given an empty keep list, and the entity adapter called it even when nothing valid was extracted. The adapter and the in-memory twin now never call or run it for an empty or missing list (the same rule the relationship side already had). Tests: `tests/org-entity-empty-keep.test.ts` (8; with the guards removed 4 fail). One existing test in `tests/org-memory.test.ts` used an empty extraction to make a record stale; it now uses a non-empty extraction that omits the record. Consequence to know: a document that genuinely now states nothing keeps its old records current until they are rejected by hand or the source is archived.

## Default-off safety flag `BROKO_ORG_RELATIONSHIPS` (added 2026-11-12, minimal)

The flag was added while 0014 was not yet applied (the route's relationship extraction and the `memory.relationships.find` chat tool would have hit a missing table). 0014 is now applied to broko-dev, **but the flag stays OFF** until the Phase 2A gates pass and a controlled relationship run is approved: both features are off unless `BROKO_ORG_RELATIONSHIPS=1` (exact value). Gate points: the ingest route (extractor only built when on) and `gateRelationshipTool` in `src/lib/chat-model.ts` (tool hidden from the model when off). 0014 is applied and audited on broko-dev (18/18); set the flag to 1 only for an approved, controlled run. 3 tests in `tests/org-relationships-remediation.test.ts`. Removing the flag restores the previous behaviour.

## Known limitations (v1)

- **Same-document links only.** Cross-document linking (e.g. a task in one page, its owner in another) is not supported; the SQL refuses it. It would need a reviewed identity-resolution step first.
- Name search (`query`) matches endpoint names only, not descriptions.
- The adapter over-fetches up to 200 rows and filters endpoint eligibility in code (PostgREST cannot express it); result limits are applied after filtering.
- The adapter has never run against a real PostgREST: embedded-select FK hint names (`org_relationships_from_entity_id_fkey`, `…_to_entity_id_fkey`) are the Postgres defaults and must be confirmed live.
- No relationship review UI exists yet (the reader methods and queue are ready; Phase 2A also has no entity review UI beyond its existing queue).

## Local verification (2026-11-11) — local results only

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint src tests --quiet` | clean |
| `npm test` | 1447 / 1447 pass (1385 before the remediation, +25 in `org-relationships-remediation.test.ts`, +10 in `org-memory-live-script.test.ts`, +9 in `org-extraction-truncation.test.ts`, +8 in `org-entity-empty-keep.test.ts`, +10 in `org-relationships-smoke.test.ts`) |
| 0014 PGlite SQL test | 102 / 102 (includes the expanded 18-row catalog audit, 12 mutation checks proving the audit can fail, all 12 relation types, and 14 checks for the stale-approval and empty-keep corrections; run against the pre-edit SQL, 5 of them fail, so they do detect the defects) |
| 0013 PGlite SQL test (regression) | 53 / 53 |
| `npm run build` | success |
| Live / remote | 0014 applied to broko-dev and catalog-audited 18/18 (database level only); **no live relationship behaviour has been run** |

## Read-only PostgREST smoke test (2026-11-12) — PASSED 19 / 19 (owner-executed; the assistant saw the closing lines and the summary, not every line)
Owner-reported result of `--execute` (without `--with-noop-rpc`): `SUMMARY 19 passed, 0 failed`. The visible lines confirm: member adapter refused (Z1) and `getRelationship` null (Z2); member direct reads of both tables returned 200 with an empty list (Z3m, Z4m); anonymous reads were denied with `401 42501 permission denied` (Z3a, Z4a). The count matches the script's full list (sign-in and roles, the five embedded selects, two negative controls, five adapter calls, the member and anonymous checks), so the embedded selects, both entity-endpoint embeds, the document embed, the history query and the negative controls resolved as expected through PostgREST. **Not covered:** row-level-security FILTERING (the tables are empty), the RPC signatures through PostgREST (`--with-noop-rpc` was not run), and any relationship write, extraction or review. The description below is the original plan.

**No-op function check, database level (2026-11-12, broko-dev, assistant-run, rolled back).** The exact arguments of `--with-noop-rpc` were verified non-mutating from the 0014 code (every write sits after an early exit these inputs hit: `review` raises `P0002` before any write when the id does not exist; `stale_missing` returns 0 for an empty keep list; `upsert` returns `skipped` when an endpoint does not exist; all three call `org_memory_guard()` first) and then run as the admin, a member and anon inside ONE transaction that always aborts. Results: admin review of an unknown id `P0002`; admin `stale_missing([])` `0`; admin `upsert` with unknown endpoints `skipped`; member review, upsert and stale_missing `42501`; anon review `42501`. Row counts (relationships/events/entities/documents) were `0/0/10/6` before and after inside the transaction and again in a separate query afterwards; the all-zero ids match no row. This does NOT prove the function signatures through PostgREST: that is the owner's `--with-noop-rpc` run, still pending. Plans: `docs/PHASE2B_CONTROLLED_WRITE_TEST_PLAN.md` (one synthetic relationship, not executed) and `docs/PHASE2A_K1K2_FIX_PROPOSAL.md` (K1/K2 fix, not implemented).

(Original status line: PENDING, not executed.)
`tests/live/org-relationships-readonly.live-dev.script.ts` (`--dry-run`, `--execute`, optional `--with-noop-rpc`, off by default) probes, as the signed-in admin, the adapter's exact embedded select (`REL_SELECT`, now exported), each embed alone (from, to, document), the history table, two negative controls (an embed with no hint and one with a wrong hint must fail with `PGRST201`/`PGRST200`), the adapter's find/queue/get calls on the empty tables, and member and anonymous reads. It only SELECTs, never reads `BROKO_ORG_RELATIONSHIPS`, never runs ingestion or extraction and never uses `service_role`. An empty table still proves the embeds resolve (PostgREST plans them from its schema cache before reading rows) but cannot show row-level-security filtering; that waits for the controlled write test.

Database facts read from broko-dev without credentials (catalog and counts only): two foreign keys from `org_relationships` to `org_entities` (a hint is required) and one to `org_source_docs`; both hint names exist; grants are `authenticated: SELECT` only; both tables hold 0 rows; PostgREST's DDL watch event triggers exist; 3 auth users, all confirmed, none banned; profiles are 1 admin and 2 members. **PostgREST responses, embed resolution through PostgREST and authorization behaviour through the API remain unverified until the owner runs the script.**

## Remaining steps (status as of 2026-11-12)

1. Phase 2A first: owner runs the live script (`--execute --wait-expiry`, then `--verify-persisted`) and the route restart check; all gates must pass. **Not done.**
2. ~~Apply 0014 to broko-dev~~ **Done 2026-11-12** (broko-dev only).
3. ~~Run the catalog audit~~ **Done: 18 / 18 rows pass** (the audit has 18 rows, not 8).
4. ~~Confirm the embedded-select FK names resolve in PostgREST~~ **Done (smoke test 19/19, owner-reported).** The `org_relationship_*` RPC signatures through PostgREST are still unconfirmed (`--with-noop-rpc` not run).
5. Extend the live script with relationship checks (create, idempotent re-run, approve inferred needs reason, reviewed not overwritten, reject sticks, anon/non-admin denied, archive hides) and run it as the owner.
6. Decide on a relationship review UI and on cross-document linking.
7. Nothing is committed; commit/merge/deploy only on the owner's instruction.
