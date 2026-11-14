# Phase 2B controlled write test — ONE synthetic relationship (PLAN ONLY, NOT EXECUTED)

**Status (2026-11-12): plan only. Nothing here has been run, the script does not exist yet, and nothing is written to broko-dev.** Execution needs the owner's explicit approval of this plan. Target: broko-dev (`olngcbgkxbceqpikcyxk`) only. `BROKO_ORG_RELATIONSHIPS` is not touched (the flag only gates the ingest route and the chat tool; this test calls the adapter directly). No model call, no extraction, no Notion call, no `service_role`.

## Why this design
* 0014 links two EXISTING entities of the SAME document, and entities exist only after 0013 ingestion writes. So the test needs a tiny synthetic document with three synthetic entities. These come from the adapter's own writer (`upsertDoc`, `upsertEntities`, `markExtracted`) fed a FIXTURE, never from Claude or Notion. The relationship itself is supplied by the fixture and pushed through the real validator first.
* One relationship, exercised through its whole life, covers every rule: validation, creation, idempotency, row-level security with real data, stale protection, the inferred-needs-a-reason rule, reviewed-never-overwritten, revision, rejection, history and the empty-keep safeguard.
* Same isolation as the Phase 2A live script: workspace `live-test-<runId>`, source ids `<runId>-p1..2`, results file in `%TEMP%\broko-org-memory-live` (ids and statuses only), a state file, cleanup on signals and in `finally`, a `--cleanup <state-file>` recovery mode, `--dry-run` that contacts nothing. Same seven `PRECON_LIVE_*` variables, typed in the owner's window.

## Data created (all synthetic, all under the run's workspace)
| Object | Count | Detail |
|---|---|---|
| Source document | 1 (+1 tiny second document for the cross-document check) | segments: S1 title, S2 "Priya will send the checklist by Friday.", S3 an instruction-like line (flagged on ingestion) |
| Entities | 3 (+1 in the second document) | person "Priya"; task "Send checklist" (owner Priya); task "Spare" (rejected during the test, to prove rejected endpoints are refused) |
| Relationship | **1** | `ASSIGNED_TO` task "Send checklist" -> person "Priya", evidence S2, starts as basis `inferred`, confidence `medium` |
| Review events | up to 4 | approve, accept_revision, reject (and one refused attempt that writes none) |

## Steps and expected results
| ID | Role | Step | Expected |
|---|---|---|---|
| W0 | none | `--dry-run` | prints this plan; names of the variables set; target guard passes; contacts nothing |
| W1 | admin, member | target guard; sign-in; roles admin/member; preflight counts (relationship tables, active non-synthetic documents) | A1/A2 as before; both relationship tables hold 0 rows before; if any exist the run stops (no empty-table assumptions) |
| W2 | admin | create the synthetic document and 3 entities with the writer; mark extracted | document and entities stored, entities `proposed` |
| W3 | none (local) | run the fixture through `validateRelationships` | the valid link is kept; each of: wrong type pair, person absent from the cited text, flagged segment S3 cited, nonexistent segment, self link is rejected with its fixed reason code. No database involved |
| W4 | admin | evidence validation by the DATABASE (calls that must store nothing): `upsert` citing a nonexistent segment; citing flagged S3; endpoints from two different documents; same entity as both ends; an endpoint that is a rejected entity | `22023` for the first three, `skipped` for the last two; relationship table still 0 rows |
| W5 | admin | create the ONE relationship (`upsertRelationships`), then repeat it | `created`, then `unchanged`; exactly 1 row; `review_status = proposed`, `stale = false`, evidence `["S2"]`, basis `inferred`, confidence `medium` |
| W6 | admin | adapter reads: `findRelationships`, filtered by type and by name ("Priya"), `getRelationship`, `listRelationshipQueue` | each returns the link with both endpoint names resolved through the embeds; history `[]`; it is in the queue as proposed |
| W7 | member, anon | row-level-security FILTERING with real data: member direct select on both tables (full `REL_SELECT`), member adapter, anon direct select, member calls the three functions with no-op inputs | member direct reads: 200 with an EMPTY list (the row exists, so this is real filtering); member adapter empty; anon `401 42501`; member functions `42501` |
| W8 | admin | stale protection: `stale_missing` with a keep list that omits the link | the link becomes `stale`; `approve` is refused (`55000`, the adapter refuses first, and the database independently when called directly); re-upsert of the same link -> `updated`, stale cleared |
| W9 | admin | empty-keep safeguard: `stale_missing(doc, [])` | returns 0 and changes nothing |
| W10 | admin | approve an INFERRED link without a note, then with one | without: `22023`, still proposed, no event; with a written reason: `reviewed`, one `approve` event with the note and the admin's id |
| W11 | admin | reviewed is never overwritten: upsert the same pair with a different basis (`extracted`) | `staled`: the stored link still says `inferred`/`medium`/reviewed, `stale = true`, a pending revision holds the new values; a reader sees `source_changed` |
| W12 | admin | `accept_revision` | the revision is applied (basis `extracted`), stale cleared, still reviewed; history now `approve`, `accept_revision` in order |
| W13 | admin | `reject` with a note, then re-upsert the same pair | `rejected` with an event; the re-upsert returns `unchanged` and the link stays rejected; default reads no longer return it, `include_rejected` does |
| W14 | admin | history | exactly three events (approve, accept_revision, reject), actor = the admin profile, notes as written, no event for refused calls; member cannot read the events table |
| W15 | admin | archive the synthetic document (`archiveDoc`) | relationship and entities disappear from the adapter's default reads (the document embed filters archived); the rows remain |
| P1 | fresh process | `--verify-persisted <state-file>` (optional) | re-reads the archived state: link rejected, 3 events, hidden from default reads |

## Cleanup
* The API has no DELETE by design. Cleanup is the archive in W15 (also run in `finally`, on SIGINT/SIGTERM/SIGBREAK/SIGHUP, and by `--cleanup <state-file>`, which touches only the recorded synthetic ids and refuses anything else). No run lock is taken by this test.
* Rows remain: 1 document (+1), 3 entities (+1), 1 relationship, 3 events. A purge would be exact `delete` statements by workspace/run id, **written out for the owner and run only after a separate approval** (children first: events, relationships, entities, documents). Until then the data is hidden from every reader.
* The final report lists counts of the four tables before and after so the owner can see that nothing outside the run's own ids changed.

## Stop conditions
Abort without writing if: the target guard fails; either sign-in fails (status and code printed); roles are not admin/member; any relationship row already exists; a non-synthetic active document exists and a step would read across it (this test does not, but the preflight reports it); any W4 call stores a row. A failed check does not stop the cleanup.

## What this test still would not prove
Real Claude relationship extraction (no model call), the ingest route with the flag on, the chat tool with the flag on, behaviour on long documents, or anything about production. Those are later, separately approved steps.
