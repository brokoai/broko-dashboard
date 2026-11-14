# Organizational knowledge for the Broko AI Brain

Status (2026-10-31): migrations `0009` and `0010` **are applied to the development project `broko-dev`** (their stored statements match the files, and the read-only catalog audit passes). The knowledge tables were empty. **Nothing here has been exercised live with real sessions**: behaviour is proven only by local tests (unit tests and a local PostgreSQL, PGlite). Migration `0011` is a **draft, not applied anywhere**. See `docs/MIGRATION_STATUS.md`. The "PROPOSED, NOT APPLIED" headers inside the applied `0009` and `0010` files are intentionally unchanged: editing an applied file would make it differ from what the database ran.

## What it is, and what it is not

- It is text that a person **deliberately wrote down** (a decision, a correction, a procedure, a project note) and an **administrator approved**. The Brain retrieves it like any other source and shows where it came from.
- It is **not** copied from chat. Nothing a user types into the assistant is ever saved as knowledge, automatically or otherwise.
- It is **not** model training or fine-tuning. The model is not retrained. Approved text is only *retrieved* at question time.
- It is **not** the chat audit. `chat_audit` stays metadata-only; feedback is also metadata-only.

## Lifecycle

`proposed` → `approved` | `rejected`; `approved` → `expired` | `superseded`.

| From | Action | To | Who | Notes |
| --- | --- | --- | --- | --- |
| (new) | submit | proposed | any signed-in user, as themself | status/author/timestamps are not writable columns; strict schemas reject forged fields |
| proposed | approve | approved | administrator | records reviewer, time, note; a replacement supersedes the item it replaces in the same transaction |
| proposed | reject | rejected | administrator | a reason is required |
| approved | expire | expired | administrator | original approver stays on the item; who expired it is in the history |

Every change is written to `knowledge_events` (submitted / approved / rejected / expired / superseded) by the database function. Nobody can UPDATE or DELETE through the API.

## Who sees what

- Administrators: everything, plus the review queue, history and feedback totals.
- Members: **approved, in-effect, unexpired** items, plus **their own submissions in any status**. Another member's proposal, a rejected, superseded or expired item is invisible to them.
- Project-scoped knowledge follows the Pre-Construction project rules: if you cannot see the project (for example it is archived and you are not an administrator) you cannot see its knowledge.
- There is no "user" scope. User isolation is: members only ever see their own unapproved items.

## How the Brain uses it

- `src/lib/ai-brain/chat/knowledge.ts` follows the `SourceAdapter` contract. Authorization is applied again inside the adapter (visibility, currency, project access) even though the repository and the database already filter.
- An explicit knowledge question ("how do we…", "what did we decide…", "our procedure for…") is answered from knowledge, including an honest "nothing matched" or "unavailable". Otherwise-unsupported questions fall back to knowledge **only when approved knowledge really matches** (at least 60% of the significant words, keyword-based; no embeddings).
- A Pre-Construction answer scoped to one project gets that project's approved notes appended, labelled "Approved notes for this project".
- **Conflicts** (two current items with the same topic and different text) are shown side by side. The assistant does not pick one.
- **Stale** (not reviewed for 180 days) items are still used but labelled as possibly out of date.
- If the knowledge store is missing or fails, ordinary chat is unchanged; explicit knowledge questions say so honestly; nothing from the failure (connection strings, raw errors) reaches the reply.
- Knowledge text is untrusted data: it is length-limited, shown as text, scanned for secrets at submission (refused) and for instruction-like wording (flagged for the reviewer, never obeyed).

## Feedback and corrections

- "Useful / Not useful" under each answer sends only: rating, a fixed reason, the answer's intent and source ids. No question, no answer text, no comment field exists.
- "Suggest a correction" opens the normal submission form (kind = correction). A correction is a proposal like any other and takes effect only after approval; it can name an approved item to replace.
- The demo never saves feedback and says so.

## Migrations

Order: `0009_knowledge.proposed.sql`, then `0010_chat_audit_vocab.proposed.sql` (both applied to `broko-dev`), then, only with the owner's approval, the draft `0011_knowledge_guards.proposed.sql` (next section). A new database, for example a new client's, takes all of them in that order. Without 0010, audit rows for knowledge answers are refused by the database's vocabulary check (the app logs it and chat is unaffected). Without 0009 the Supabase repository fails honestly and chat keeps working.

Local verification: `node supabase/proposed/tests/0009_knowledge.pglite.mjs` (PGlite, needs `npm install --no-save @electric-sql/pglite`), plus the read-only `supabase/proposed/tests/0009_catalog_audit.proposed.sql` (run live on broko-dev; it passed). The local run found and fixed one real defect (a policy that queried its own table was rejected as infinite recursion; replaced by the definer helper `knowledge_replaceable`).

## Migration 0011: replacement guard and content removal (applied to broko-dev only; structurally verified; live-tested on broko-dev except G2)

Two defects found in the review of 0009, fixed in a new draft so the applied files stay untouched:

1. **A replacement must match the item it replaces in scope, project and topic (strict equality, owner decision A; no fuzzy matching).** Before, a proposal could name any approved item it could see, and approving it silently retired that item. Now the insert policy, `knowledge_review()` (at approval) and the app (at submit and at review) all refuse a mismatch. The review card also shows **which item will be replaced, by title**, and warns when a proposal could not be approved. The card and the app checks work today; the database half needs 0011.
2. **Administrators can remove the content of an item** with `knowledge_redact(id, reason)`. The reason comes from a fixed list (secret, personal data, incorrect, other), never free text. Title and body become fixed text; topic, source note and review note are cleared; that item's history notes are cleared; the item stops being used; one `redacted` history row records who and when. The row is kept, so history and links stay intact. **It cannot reach copies outside the database** (backups, logs, exports, an answer that quoted the item earlier). **There is no button for it yet**; the app does not call it.

Verified locally, structurally on broko-dev after the apply, and by live group G on broko-dev (G1, G8-G12 passed; G2 blocked): `node supabase/proposed/tests/0011_knowledge_guards.pglite.mjs` (69 checks, plus 10 that show the defect existed before). The read-only audit to run after an approved apply is `supabase/proposed/tests/0011_catalog_audit.proposed.sql`.

## Migration 0012: database secret check (applied to broko-dev only; structurally verified; live-tested on broko-dev)

`supabase/proposed/0012_knowledge_secret_check.proposed.sql` puts a floor under the application's secret screen, so a signed-in member calling the API directly cannot store a credential.

- **What:** a BEFORE INSERT/UPDATE trigger on `knowledge_items` (title, body, topic, source_ref, **review_note**) and one on `knowledge_events` (note). It refuses seven high-signal formats: private-key header, `sk-`/`pk-`/`rk-` keys, Supabase keys, JWTs, AWS access keys, GitHub tokens, Slack tokens. Zero-width and control characters are stripped first. The error carries the pattern id only, never the text.
- **Review notes (owner decision B):** written only by `knowledge_review()` (administrators; SECURITY DEFINER, so the screen sits on the tables, not in the function). The same seven formats and nothing broader, so ordinary comments are not restricted. A refused note aborts the whole review; the item keeps its status. The application already screened notes (`service.ts`); the database now agrees.
- **No bypass:** the triggers fire for every role including the table owner. No API role has a direct write path to either note column (privilege-denied, tested).
- **Not covered (floor, not detector):** "password is ..." assignments, long hex, long opaque tokens, SSNs, card numbers. The application still refuses these on the normal path; a direct API insert can store them.
- **Existing rows:** nothing is scanned or changed by applying the file. A row stored earlier that already holds a secret **cannot be approved or rejected** afterwards (the review update re-checks the whole row and is refused); the administrator removes it with `knowledge_redact()`, which writes clean text. Approving or expiring other rows is unaffected.
- **Verified locally and structurally on broko-dev:** `node supabase/proposed/tests/0012_knowledge_secret_check.pglite.mjs` (116 checks plus 10 before-state), `tests/knowledge-secret-drift.test.ts`, and the read-only `0012_catalog_audit.proposed.sql` (run on broko-dev after the apply: no exception). Behaviour under real sessions is covered by group G of the live script: run on broko-dev, G1 and G3-G12 passed and G2 is blocked by design (see "Phase 3C live verification" below).

## Phase 3C live verification on broko-dev (run 2026-11-02; read this before trusting any "verified" claim)

Script: `tests/live/knowledge-live-dev.script.ts` (57 planned checks), run by the owner against `broko-dev` only, with synthetic data and cleanup through the existing review/redaction controls. Run `20261102192712-cf03d6`.

**Result: 51 passed, 1 failed, 5 blocked, 0 not run.** Cleanup passed (F1, F2): no proposed or approved test record remains, and none is retrievable. `chat_audit` stayed at 121 rows (E6).

**The one failure was D5, and it was a wrong test expectation, not a database defect.** For the case "project scope without project" the live database refused the insert with SQLSTATE **42501** (row-level security stops it before the CHECK constraint runs); the test had expected only **23514**. The test assertion was corrected locally to accept 23514 or 42501 for that case. The corrected assertion has passed the local test suite but **has NOT been rerun against Supabase**, so D5 has not passed a corrected live verification. The other eight D5 shapes were refused with the expected codes in the run.

**Current `broko-dev` baseline (after that run):** knowledge_items 42, knowledge_events 112, answer_feedback 2, chat_audit 121. A next run needs `KNOWLEDGE_LIVE_EXPECT_ROWS="42,112,2"`. The test rows are terminal (rejected, superseded or expired) and invisible to users; they are not purged.

| Status | What |
|---|---|
| **Live verified** (passed in the run above) | A1-A6, B1-B12, C1-C10, D1, D2, D3, D7, E1-E4, E6, F1-F3, G1, G3-G12. This covers 0009 and 0010 behaviour and, through group G, the 0011 replacement-topic guard and `knowledge_redact` and the 0012 secret check, under real member, admin and anon sessions. |
| **Live failed, cause understood** | D5 (original expectation only; see above). Corrected live rerun still outstanding. |
| **Blocked, NOT live verified** | **D4** stale labelling (`reviewed_at` is set by the database; covered locally by `tests/knowledge.test.ts`). **D6** and **D8** project-scope proposal and retrieval for an ACTIVE project (none exists on broko-dev; creating one would change project data). **E5** `source_ids` `'knowledge'` in `chat_audit` (any live probe would store a permanent audit row; covered by the read-only catalog audit). **G2** approval-time topic-mismatch refusal (23514; the insert policy stops a mismatched row first; covered by the local PGlite test with an owner-inserted row). |
| **Locally verified only** | Everything in the PGlite suites (0009: 122 checks; 0011: 69 plus 10; 0012: 116 plus 10), the drift test, and the unit tests. Local results do not prove live behaviour. |

Not covered by any live test: the Brain's retrieval in a browser session, and anything on production (nothing has been applied there).

## Decisions made without asking (please review)

1. Scopes are `organization` and `project` only.
2. An administrator may approve their own submission (recorded in the history). Members cannot approve anything. *Updated 2026-11-02: this is still how the code and database behave, and a second-reviewer rule is an unresolved proposal (D6), not policy and not built; see `docs/ADR_BRAIN_V1_DECISIONS.md`.*
3. Only administrators see the review history and the feedback totals.
4. Search is keyword-based with light ending-tolerance (approve/approver). No embeddings.
5. 0010 is a separate migration; 0008 is untouched.
6. Rate limits: 30 submissions/min and 60 feedback/min per user (database triggers; the memory repository mirrors them).
7. The Knowledge page is visible to every signed-in user (reading and proposing); review controls render for administrators only and are enforced server-side.

## Limitations

- Not verified live with PostgREST or real sessions, although 0009 and 0010 are applied to broko-dev. The Supabase adapter is checked by a stub contract test only.
- No semantic search; synonyms are not understood.
- No bulk import, no attachments, no editing of an approved item (replace it via a correction instead).
- Feedback is aggregated into two totals; there is no per-intent report yet.
- Multi-company tenancy is not implemented (`organization_id` is reserved and unused).

## OneDrive and other integrations: not started

The repository has no Microsoft Graph code and no credentials. Connecting OneDrive needs, outside this codebase: an Azure/Entra app registration, admin consent for the chosen scopes (read-only `Files.Read` on a specific folder is the safest start), and a decision on where tokens live. The safest design is **ingest-as-proposals**: a connector would create `proposed` items with `source_ref` pointing at the file, which an administrator reviews like any other submission; it would never write approved knowledge directly. No placeholder connectors or buttons were added. Teams, Outlook, Gmail, Notion, calendars and Drive sync are likewise not started.

## Adding another source later

Implement `SourceAdapter` (`id`, `retrieve(ctx) → Outcome`), re-apply authorization inside it, return minimal `RetrievedRecord`s with provenance, add its id to `SOURCE_IDS`, and add a migration that widens the chat-audit vocabulary (as 0010 does). `tests/chat-audit.test.ts` fails if the code and the SQL vocabulary drift.
