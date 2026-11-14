# K1/K2 — token-aware memory search: root cause, proposed diff and regression tests

**Status (2026-11-12): PROPOSAL ONLY. Nothing below is implemented.** Awaiting the owner's approval. No migration is involved.

## Root cause (code-derived, reproduced locally with a scripted model; not yet confirmed by a live trace)
1. All four K questions route to intent `unsupported` (checked with `routeIntent`), so the tool agent is attempted for K1, K2 and K3 alike. Intent routing is not the difference.
2. Memory search (`findEntities` in the Supabase adapter AND in the in-memory twin; the relationship name search the same way) treats the whole query as ONE contiguous substring over name, description, owner and team.
3. K1/K2 ask about "the Halcyon warehouse slot". The stored record is "Confirm warehouse slot" / "Dana confirms the warehouse slot."; "Halcyon" is only in the page title. A natural query such as "Halcyon warehouse slot" returns 0 records ("warehouse slot" returns 1).
4. With nothing delivered the model's "not found" answer has no citation, the tool agent declines it (`uncited`, `tool-agent.ts` `used.size === 0`), and the ordinary path returns the fixed-scope capabilities text: the exact symptom (generic reply, 0 reads, 0 citations).
5. The live script now prints a content-free trace (tool, redacted query, record count, `agent=answered|declined:<code>`), so the next run confirms or refutes this.

## Proposed change (smallest sufficient)
**New file `src/lib/ai-brain/org-memory/query.ts`**
```ts
/** Words too common to identify a record. A short fixed list: this is a recall aid, not a language model. */
const STOP = new Set(["the", "and", "for", "are", "what", "who", "does", "did", "say", "says", "about", "our", "stored", "notes", "note", "from", "with", "that", "this", "was", "how", "when", "where", "which", "tell", "show", "find"]);
/** The searchable words of a query: lower-case, letters/digits only, at least 3 characters, no stop words, at most 6. Empty = fall back to the whole phrase. */
export const queryTokens = (q: string): string[] =>
  [...new Set(q.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N} _.-]/gu, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 6);
/** How many of the tokens occur in the text (the ranking score). */
export const tokenHits = (tokens: readonly string[], text: string): number => { const t = text.toLowerCase(); return tokens.filter((k) => t.includes(k)).length; };
```
**`src/lib/backend/supabase/org-memory.ts` — `findEntities`**
```diff
-      const needle = q.query?.replace(/[^\p{L}\p{N} _.-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100);
-      if (needle) b = b.or(`name.ilike."%${needle}%",description.ilike."%${needle}%",owner.ilike."%${needle}%",team.ilike."%${needle}%"`);
-      const rows = check(await b.order("extracted_at", { ascending: false }).limit(Math.min(q.limit, MAX_ROWS))) ...
+      const tokens = q.query ? queryTokens(q.query) : [];
+      const needle = q.query?.replace(/[^\p{L}\p{N} _.-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100);
+      const words = tokens.length ? tokens : needle ? [needle] : [];   // no usable word: the previous whole-phrase behaviour
+      if (words.length) b = b.or(words.flatMap((w) => ["name", "description", "owner", "team"].map((c) => `${c}.ilike."%${w}%"`)).join(","));
+      // more matched words first, then newest; fetch wide enough to rank, then cut to the requested size
+      const rows = check(await b.order("extracted_at", { ascending: false }).limit(words.length > 1 ? MAX_ROWS : Math.min(q.limit, MAX_ROWS))) ...
+      const ranked = words.length > 1 ? sortByHits(rows, words).slice(0, Math.min(q.limit, MAX_ROWS)) : rows;
```
(`sortByHits` is a stable sort by `tokenHits(words, name+description+owner+team)` descending, keeping the existing newest-first order within equal scores.) The relationship name search (`ents().select("id").ilike("name", ...)`) uses the same helper on `name` only.

**`src/lib/ai-brain/org-memory/memory-repo.ts` (twin)** — `findEntities`: replace `includes(needle)` with "at least one token occurs (or the whole phrase when there are no tokens)", sort by `tokenHits` descending then the existing order. `findRelationships`: the same on the endpoint names.

**`src/lib/ai-brain/assistant/memory-tools.ts`** — one added sentence in the `memory.entities.find` and `memory.relationships.find` descriptions: "`query` is matched word by word against names, descriptions, owners and teams: pass one or two distinctive keywords, not a whole question." And an empty result carries a fixed hint: `"hint": "No stored record matched. Try one distinctive keyword, or omit the query and filter by type."` (`tool-agent.ts`, `memoryFind` / `memoryRelationships`, when `records.length === 0`).

## What does not change
The citation rules (an uncited answer is still declined), the Tool Registry, the intent router, the model provider, and every migration. The honest "no stored record matches" answer is still turned into the generic reply; changing that would loosen the grounding contract and is a separate decision (not proposed).

## Trade-offs
* Broader recall: an OR over words returns more candidates (still capped at the requested limit, ranked by matched words). Every statement still needs a delivered citation.
* One extra wide fetch (up to 200 rows, already the adapter's cap) when a query has two or more words.
* The stop-word list is short and English-only; a query of only stop words falls back to the whole phrase.

## Regression tests to add (all local)
1. `queryTokens`: drops stop words and short words, de-duplicates, caps at 6, never returns characters outside letters, digits, space, `_`, `.`, `-`.
2. Twin: with the K1/K2 fixture ("Confirm warehouse slot" / "Dana confirms the warehouse slot."), the queries "Halcyon warehouse slot", "stored notes Halcyon warehouse slot" and "warehouse slot" each return the record; "budget" returns nothing; ranking puts the two-word match above a one-word match.
3. Adapter (stub client): the filter sent is the OR of `name/description/owner/team.ilike."%token%"` per token; a single token or no usable token falls back correctly; the result is cut to `limit` after ranking; no `service_role`.
4. Relationship name search: the same recall through `findRelationships({ query })`.
5. End-to-end scripted-model test through `askBrain`: the model queries "Halcyon warehouse slot", receives the record, answers with a valid citation, and the reply is the memory answer (not the capabilities text); a second case where nothing matches still ends in the ordinary reply.
6. Pin that the tool results for an empty search contain the fixed hint and no record text.
7. The existing 1447 tests keep passing; the K pass conditions in the live script are unchanged.

## Live confirmation after approval and implementation
Re-run the live script (the trace lines show query, record count and answered/declined code). K1/K2 should then pass; K3 stays weakly tested for the "missing evidence" case until the optional grounding decision is made.

---

## Implementation status (2026-11-12): IMPLEMENTED LOCALLY, AWAITING LIVE RERUN
* New `src/lib/ai-brain/org-memory/query.ts` (word tokenizer, stop words, max 6 words, ranking by matched words).
* Adapter (`findEntities`, `findRelationships` name search) and in-memory twin now match word by word, rank, then cut to the caller's limit. Authorization, evidence validation and citation rules are untouched.
* `memory.entities.find` / `memory.relationships.find` descriptions tell the model to pass one or two keywords; an empty result carries a fixed hint.
* Tests: `tests/org-memory-search-tokens.test.ts` (9), two end-to-end cases in `tests/org-memory-service.test.ts`, and the adapter contract test updated for the multi-word filter shape. Suite: 1458 pass, 0 fail.
* NOT yet verified live: K1/K2 must be rerun against broko-dev with the owner's approval. Phase 2A remains NOT COMPLETE.

## Follow-up (2026-11-12): search limits fixed locally
* Entity search: stable pages (newest first, then id), 200 rows per page, at most 10 pages; the best rows are kept incrementally and reading stops early when nothing later can win. Hitting the last full page sets `budget_reached`, which the tool result and the model hint report ("may be incomplete", never "no match").
* Relationship search: endpoint ids are read in stable id order (up to 1000), sent in batches of 50 per request, merged and de-duplicated, then ordered, ranked and cut to the limit. A full batch or id budget is reported the same way.
* `_` and `%` are separators in the query words, so no LIKE wildcard reaches the database and the adapter matches the in-memory twin.
* Tests: `tests/org-memory-search-limits.test.ts` (15). Suite: 1473 pass, 0 fail. Not yet verified live; Phase 2A remains NOT COMPLETE.

## Live confirmation (2026-11-12): K-only run 20261112180412-d2ae4c PASSED (K1 and K2), after two further fixes
The token-aware search above was not the whole story. Three live K-only runs on broko-dev (synthetic, one source each, archived afterwards) showed two more causes, found only because the live trace was instrumented. The earlier failures are kept as the record.

1. **Run `20261112172003-a379af` (K1 FAIL, K2 FAIL).** The model passed `entity_type` decision / commitment / meeting; the stored record is a `task`, and the type was a strict filter, so the search returned 0 records and the tool-call budget ran out. Fix (local): `entity_type` is a hint. A typed search that finds nothing is repeated once without the type (only when a query was given, never after an error); the result is marked `untyped_fallback` and every record carries its own type; the memory prompt and tool description say to leave the type out unless the user names one and that an empty result does not mean nothing exists. Tool selection was also corrected so stored-notes questions start with memory search and Notion meeting search is kept for meeting-specific questions. `MAX_ROUNDS` (3) and `MAX_CALLS` (4) were not changed.
2. **Run `20261112175638-76e779` (K1 FAIL, K2 FAIL).** The search worked (1 record, evidence `M1.S2` delivered) but the final answer had one factual item without a citation, so the all-or-nothing validation declined the whole answer (`declined:uncited`) and the generic fallback reply was shown. Fix (prompt only): `MEMORY_PROMPT` now says the review status is structured data from the record (not page text) and goes inside the cited sentence, never as a separate item; absence is stated only in the coverage form ("not found in the retrieved notes", never "does not exist"); related claims supported by one segment are one item with one factual sentence. `finalizeItems` and every validation rule are unchanged.
3. **Run `20261112180412-d2ae4c` (K1 PASS, K2 PASS; 9 passed, 0 failed).** Model `claude-haiku-5-5`. One valid distinct citation, `M1.S2`; the predicted validation branch matched the agent's outcome (`answered`). Cleanup passed (source archived and verified, lock released) and the pre-existing rows are identical by fingerprint (10 documents, 14 entities, 0 relationships, 46 Knowledge items). Residual synthetic rows (1 archived source, 1 entity, 1 ingest-run row) were not deleted. Details: `docs/PHASE2A_COMPLETION.md`, section 12.

Diagnostics added to the live script only (no application behaviour change): the trace records, per memory call, the query, `entity_type`, limit, filter shape and row count, and per model turn the tools named and a content-free breakdown of the final submission (items, factual sentences, citation ids and whether each was delivered, and the validation branch it predicts).

**Limits of this result:** it is one successful live run; reliability across repeated runs is NOT established, and the model is not deterministic. Phase 2A remains NOT COMPLETE (K3/K4 in the full script, R3, L2, fresh-process persistence and the route-restart test are outstanding). Phase 2B is NOT production-ready and NOT live-verified.

## Three-Run Live Acceptance and Citation Reliability Findings
Recorded 2026-11-12. Read-only: no application code, prompt, test, migration, environment setting or database record was changed for this section, and no live test or Supabase / Anthropic call was made to write it.

### Results
| Run | Run ID | K1 | K2 | Overall |
|---|---|---|---|---|
| Baseline K-only | `20261112180412-d2ae4c` | PASS | PASS | 9 / 9 |
| Repeat 2 | `20261112181921-daf5ff` | FAIL | FAIL | 7 / 9 |
| Repeat 3 | `20261112182109-a6ad16` | PASS | PASS | 9 / 9 |

K1 2 / 3, K2 2 / 3, combined 2 / 3 complete runs passed (model `claude-haiku-5-5`, prompt-only correction in place). All three passed A1, KA1, KA2, KB1, KB2, KC1 and KC2; pre-existing rows were unchanged by fingerprint in each; each run archived its single synthetic source and left 1 archived source + 1 proposed entity + 1 ingest-run row (not deleted); no relationship or Knowledge record was created. This is **not** a reliability measure and K1/K2 are **not** reliably accepted. (The assistant was given the output of these three runs only.)

### Failure mechanism in Repeat 2 (recorded sanitized trace only)
* Retrieval and evidence delivery worked: 2 parallel searches, the expected record returned (1 row), `entity_type` omitted, segment `M1.S2` delivered, 2 records read.
* Claude's submission had 3 items: item 1 factual with a valid delivered cite (`M1.S2`); item 2 (68 chars) non-factual with no cite; item 3 (98 chars) **one factual sentence with no cite**.
* The finalizer's all-or-nothing rule rejected the whole answer (`declined:uncited`, branch `factual_item_without_cite (item 3)`; the script's prediction matched the agent's outcome), discarding the valid cited item with it, and the ordinary path then showed the generic fixed-scope reply.
* The failure is in Claude's answer composition / citation compliance, not in retrieval, delivery, or the validator's logic. The earlier pre-correction failure (`20261112175638-76e779`, 69-char uncited factual item 2) reached the same branch.

### Why Repeat 3 passed (and the baseline)
Same fixture, same searches (two parallel calls, 2 records read), 1 valid citation `M1.S2`. Three items: one cited factual sentence, two non-factual items with empty cites (68 chars each in Repeat 3). `predicted_branch=none`, agent `answered`, no validator weakening. The only structural difference from Repeat 2 is that no item was a factual sentence without a cite.

### Proven and unproven
* **Proven:** retrieval works; evidence segments are delivered with intact ids; the validator behaves as written and its prediction matched the real outcome in every traced case; cleanup and isolation held in all three runs.
* **Unproven:** how often Claude composes a fully compliant answer (2 of 3 here); **what the uncited item said** (the trace is content-free, so the sentence in Repeat 2 is unknown and its cause is not established); whether another model would comply more reliably; behaviour on anything but this one synthetic record.

### Read-only code inspection findings (`src/lib/ai-brain/chat/tool-agent.ts`)
* **Submission contract.** `submit_answer` requires `items` (1-30), each `{ text, cites }` with cite ids matching `^M\d+\.S\d+$`. The schema allows an empty `cites` array for every item; whether an empty list is acceptable is decided only afterwards by `finalizeItems`, so the model can submit a shape the validator will reject.
* **What counts as factual.** An item's sentences are split on `.`, `!` and `?`; a sentence is factual if it is at least 25 characters long, is not a "coverage statement", and is not a short line ending in `:`. Every factual item needs at least one delivered, valid cite, and one item may hold at most one factual sentence.
* **The coverage allowance is narrow.** `isCoverageStatement` accepts a short single-clause statement whose grammatical subject is the source ("notes", "transcript", "meeting record", "minutes", "page", "source") with a fixed list of verbs. Local classification of candidate disclosure sentences (the agent's own function, no model involved) shows:
  * allowed without a cite: "The notes do not state a due date.", "The notes do not state a due date for confirming the warehouse slot.", "The retrieved notes do not mention Halcyon.", "No due date is recorded in the notes.", "The due date is not stated in the retrieved notes."
  * **treated as factual (needs a cite):** "The record does not state a due date.", "No due date is stated for this task.", "The due date is not stated in the record.", "Owner: Dana, Operations team.", "The record status is proposed, not yet approved.", "The retrieved notes do not link this task to the Halcyon project, and nothing else was found.", "Nothing in the retrieved notes connects this to Halcyon.", "Halcyon was not found in any stored record."

  So a natural-sounding disclosure whose subject is the record or the task, that uses a verb outside the list, or that has a second clause, is classified as a factual claim that has no segment to cite.
* **Prompt versus contract.** `MEMORY_PROMPT` (after the prompt-only correction) tells the model to put the review status inside the cited sentence, to state absence only in the coverage form, and to give every other factual item a cite. It does this by example and prose; nothing machine-checkable ties the model to the narrow coverage forms, and the record's own `not_stated` list (for example `["due"]`) invites phrasing such as "the record does not state a due date", which the classifier treats as factual.
* **Consolidation.** The prompt tells the model to merge related claims supported by one segment into one item, but the schema allows up to 30 items; nothing prevents several factual items in one submission, and one uncited factual item voids all of them.
* **Existing tests** pin that the prescribed shapes are accepted and the old shapes still rejected (`tests/org-memory-answer-form.test.ts`), and the live script's trace predicts the branch (`tests/org-memory-live-script.test.ts`). No test pins the classification table above, and no test exercises repeated or varied model submissions.

### Minimal proposed remediation (NOT implemented; wait for approval)
The evidence supports the mechanism (one uncited factual item) but not the content of the sentence, so the first step is a diagnostic, then one of two bounded changes.
0. **Diagnostic (script only):** extend the content-free trace for an uncited factual item with category flags, for example: length, starts with a bullet, contains a negation, mentions a query word, mentions the review status, mentions owner / team / due. This identifies the kind of sentence without recording its text. Files: `tests/live/org-memory-supabase.live-dev.script.ts`, `tests/org-memory-live-script.test.ts`.
1. **Prompt (lowest risk), if the flags show a disclosure or status sentence:** give the model the exact allowed disclosure templates ("The notes do not state ...", "The retrieved notes do not mention ..."), tell it that any sentence about "the record" or "the task" is a factual claim that needs a cite, and add a rule to submit one cited factual item plus coverage items only. File: `src/lib/ai-brain/chat/tool-agent.ts` (`MEMORY_PROMPT` only).
2. **Deterministic disclosure, if prompting proves insufficient:** build the review-status and not-stated disclosures in code from the delivered record fields (`review`, `not_stated`) and append them after validation, so the model never has to write them. The validator is untouched. Files: `src/lib/ai-brain/chat/brain.ts` (`toolAnswer`), possibly `src/lib/ai-brain/chat/tool-agent.ts`.
3. **Not recommended without an explicit governance decision:** widening `isCoverageStatement` or dropping uncited items instead of rejecting the answer. Both weaken the all-or-nothing citation rule the project has chosen to keep.

### Regression tests to add or strengthen
* A classification-table test pinning which disclosure forms are coverage versus factual (the table above), so a later change to the coverage rule is deliberate.
* A test that every template the prompt teaches is classified as allowed (coverage) or is a cited factual item, so the prompt cannot contradict the validator again.
* A test that a submission containing a factual sentence about "the record" with no cite is still rejected.
* If remediation 2 is chosen: tests that the appended disclosures come only from delivered record fields, never from model text, and never appear for a record that was not delivered.
* A scripted multi-sample harness that replays a set of plausible submissions through the real agent, so a prompt or schema change cannot silently raise the decline rate.

### Recommended next action
Approve step 0 (the content-free sentence-category trace, script and its test only), then repeat the K-only run a few more times to learn which sentence class fails, before choosing remediation 1 or 2. Nothing is implemented, and K1/K2 are not complete or production-ready. Phase 2A remains NOT COMPLETE; Phase 2B is NOT production-ready and NOT live-verified.

## Status decision (2026-11-13): K1/K2 DEVELOPMENT COMPLETE; reliability testing deferred to production go-live
Owner decision, documentation only (no code, prompt, test, migration or database change; no live test; no Supabase / Anthropic call).

* **K1 and K2 are development-complete** for the current development phase. Further live acceptance and reliability testing is moved to the Production Go-Live / Acceptance Testing checklist in `docs/PHASE2A_COMPLETION.md` ("K1/K2 status decision (2026-11-13)").
* **Historical results kept as recorded:** four K-only runs on broko-dev — baseline `20261112180412-d2ae4c` PASS, Repeat 2 `20261112181921-daf5ff` FAIL (7 / 9), Repeat 3 `20261112182109-a6ad16` PASS, Repeat 4 `20261112183114-35c060` PASS (run with the Step 0 diagnostics; fingerprints 14 / 18 / 0 / 46 unchanged). That is three successful runs and one failed run (K1 3 / 4, K2 3 / 4). Not a reliability measure.
* **The proposal above is superseded as a to-do, not as an analysis.** Step 0 (category flags) and the persistence of the sanitized K1/K2 diagnostic into the results JSONL are implemented and tested locally; remediations 1, 2 and 3 are **not implemented** and stay available if go-live testing shows failures. The "Recommended next action" (repeat the K-only run a few more times) is deferred to go-live.
* **The citation validator is unchanged.** Remediation 3 (widening `isCoverageStatement` or dropping uncited items) remains not recommended without an explicit governance decision.
* **Development completion is not production acceptance.** The intermittent failure (one uncited factual item voiding a whole answer) is understood in mechanism but not eliminated, and its sentence class is still unknown because no failing run has yet been recorded with the Step 0 flags.
* Phase 2A is NOT COMPLETE; Phase 2B is NOT production-ready and NOT live-verified.
