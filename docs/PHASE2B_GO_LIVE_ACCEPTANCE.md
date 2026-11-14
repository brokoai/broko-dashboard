# Phase 2B — go-live acceptance checklist (relationship intelligence)

**Status (2026-11-13): NOT STARTED.** Phase 2B is **development-complete locally** and its migration is applied to broko-dev only. **Local development completion is NOT production acceptance.** Every item below is unchecked; nothing here has been run, none of it is authorized by this document, and `BROKO_ORG_RELATIONSHIPS` stays **OFF** until the enablement criteria at the end are met.

Rules for every item (unchanged from the project's standing rules):
* Each live run needs the owner's explicit authorization, one run at a time, dry-run first. Credentials come only from the owner's own PowerShell environment; the assistant never receives, prints, logs or persists them. No `service_role`.
* Target broko-dev (`olngcbgkxbceqpikcyxk`) first. Production is a separate, later decision and is never touched by a test.
* Writes are synthetic, isolated under a run-specific workspace, and cleaned up by **archiving** (the API has no delete). Purging residual rows needs a separate approval.
* A failed run is not retried; the failure is recorded and diagnosed before another run.
* Do not weaken the citation validator, the relationship validator, RLS or the review guards to make an item pass.

Related documents: `docs/PHASE2B_COMPLETION.md` (what exists, local results), `docs/PHASE2B_CONTROLLED_WRITE_TEST_PLAN.md` (the step-by-step plan for item 1), `docs/PHASE2A_COMPLETION.md` (Phase 2A gates, which come first).

## 0. Preconditions (must be true before any item below)
- [ ] Phase 2A engineering gates passed on broko-dev: R3 (`--wait-expiry`), L2 decision, fresh-process `--verify-persisted`, route-restart test (port other than 3200). See `docs/PHASE2A_COMPLETION.md`.
- [ ] Migration 0014 present and its 18-row catalog audit still 18 / 18 on the target (re-run the read-only audit; do not reapply).
- [ ] Read-only PostgREST smoke test (`tests/live/org-relationships-readonly.live-dev.script.ts`) re-run if the schema or adapter changed since it last passed (19 / 19, owner-reported).
- [ ] Both relationship tables empty or fully accounted for (any existing row is listed, not assumed away).

## 1. Controlled synthetic relationship creation
- [ ] Owner approves `docs/PHASE2B_CONTROLLED_WRITE_TEST_PLAN.md` (or a revised version) and the script that implements it exists, with a `--dry-run` that contacts nothing.
- [ ] One synthetic relationship created through the real adapter and the guarded 0014 functions (`upsertRelationships`), then repeated: `created`, then `unchanged`; exactly one row; `proposed`, not stale; stable id derived from the endpoints.
- [ ] Database-level evidence validation refuses (stores nothing): nonexistent segment, flagged segment, endpoints from two documents, same entity at both ends, rejected endpoint.
- [ ] Empty-keep safeguard: `stale_missing` with an empty list returns 0 and changes nothing.
- [ ] Cleanup archives only the recorded synthetic ids; before/after counts of the four tables show nothing outside the run changed (fingerprint of pre-existing rows).

## 2. Real Claude relationship extraction quality
Not covered by any test so far: all extraction tests use fixtures or a scripted transport.
- [ ] Run real extraction (existing transport, forced `record_relationships` tool) on a small set of real or realistic synthetic pages, on broko-dev, with the flag on for that run only.
- [ ] Record, per page and in aggregate, with **no source text in the report**: relationships proposed, kept, rejected (by fixed reason code: `shape`, `endpoint_missing`, `self`, `type_mismatch`, `evidence`, `who_not_in_evidence`, `duplicate`, `over_cap`), downgraded to `inferred`.
- [ ] Owner-defined thresholds are set **before** the run (suggested measures: precision of kept links on a hand-labelled sample, share of kept links that are `inferred`, rejection rate, extraction failure rate). The thresholds are the owner's decision; none is assumed here.
- [ ] Long pages: confirm a truncated extraction stores what it found and stales nothing (`reconcile_skipped_truncated` counted).
- [ ] Repeat runs on the same page to measure run-to-run variation (the model is not deterministic).

## 3. Application retrieval against persisted relationship records
- [ ] With the flag on for the run, a real chat question reaches `memory_relationships_find` through the existing Brain / Tool Registry / tool agent and returns the stored link with both endpoints, review state, basis and confidence.
- [ ] Questions that should and should not find a link (by entity, by name, by type) behave as expected; an empty result is reported as "not found in the retrieved notes", never "does not exist".
- [ ] The tool is hidden from the model when the flag is off (re-check after the run).
- [ ] Reliability sampling, as for K1/K2: repeated runs with the persisted K-style diagnostics (`detail` lines in the results JSONL), because relationship answers go through the same all-or-nothing citation rule and the same intermittent uncited-sentence failure is possible. Pass-rate threshold set by the owner beforehand.

## 4. Evidence and citation validation
- [ ] Every relationship the model states cites a segment that was delivered in that same tool result; a link whose source changed delivers none and cannot be cited.
- [ ] An `inferred` link is described as the notes' implication, not a fact (this is prompt-enforced only; review sampled answers by hand, record the rate).
- [ ] A `proposed` link is described as unreviewed; a `source_changed` link is not stated as fact.
- [ ] No answer text, evidence text or record value is persisted in any results file (same sanitized-diagnostics rule as K1/K2).

## 5. Row-level security with data present
The earlier smoke test ran on empty tables, so filtering was never exercised.
- [ ] Admin: can select relationships, endpoints and events; can call the guarded functions.
- [ ] Member (authenticated, non-admin): direct select on both tables returns an **empty list with the row present**; the adapter refuses before any database call; the three functions return `42501`; cannot read the events table.
- [ ] Anonymous: direct select denied (`401 42501`); functions denied.
- [ ] The row's existence is confirmed independently (so "empty" is real filtering, not an empty table).

## 6. Approve, reject and revision workflows
- [ ] Approve a proposed `explicit` link (no note needed) and an `inferred` link (a written reason is required; without one the call fails and writes no event).
- [ ] Reject with a note; re-extraction of the same pair returns `unchanged` and the link stays rejected; default reads hide it, `include_rejected` shows it.
- [ ] Revision: a changed extraction for a reviewed link produces a pending revision (`stale`, revision waiting); `accept_revision` applies it; `dismiss_revision` discards it; the earlier review is preserved throughout.
- [ ] Approving a stale link is refused (adapter first, database independently).
- [ ] History: exactly one event per accepted review action (actor, note, timestamp); none for refused calls; order preserved across list, queue and single reads; stable id never changes.

## 7. Protection of reviewed relationships
- [ ] A reviewed link is never overwritten by a later extraction, including a truncated one and one that omits it.
- [ ] An empty or all-invalid extraction stales nothing, reviewed or not.
- [ ] A relationship whose source is archived disappears from default reads; its rows and history remain.
- [ ] A reviewed link whose endpoint is later rejected or stale stops being returned as current.

## 8. Feature-flag enablement criteria (`BROKO_ORG_RELATIONSHIPS=1`)
The flag may be enabled for general use only when **all** of the following are true and recorded:
- [ ] Section 0 preconditions met, including all Phase 2A engineering gates.
- [ ] Sections 1, 5, 6 and 7 fully passed with data present.
- [ ] Sections 2, 3 and 4 meet the owner's pre-set thresholds, with the sample sizes and results written into the documentation.
- [ ] Rollback is rehearsed: with the flag turned off the ingest route builds no relationship extractor, the model is not offered `memory_relationships_find`, and ingestion behaves as before (these are already pinned by local tests; confirm in the live app).
- [ ] The owner has decided on a review surface (UI or an explicit "admin-only through the API" decision) and on cross-document linking (currently unsupported by design; see limitations).
- [ ] The decision is written down by the owner. Until then the flag stays off, including on broko-dev, except for an individually approved, controlled run.

## Known limitations that affect acceptance
* **Same-document links only.** Relationships connect two entities of one document; the SQL refuses endpoints from different documents. Links such as "task on page A, owner on page B" are not supported; supporting them would need a reviewed identity-resolution step and a change to 0014 (separate approval).
* Name search matches endpoint names only; the adapter over-fetches up to 200 rows and filters endpoint eligibility in code.
* No relationship review UI.
* Whether Claude says "inferred" for an inferred link is enforced by the prompt only, not by code.
* Real-Claude extraction quality, live RLS filtering with data, and live retrieval are unmeasured (items above).
* Ingestion run counts can double-count when only the relationship step fails and the document is retried (cosmetic).

**Local development completion does not mean production acceptance.** Phase 2B is NOT production-ready and NOT live-verified until this checklist is passed and the owner says so.
