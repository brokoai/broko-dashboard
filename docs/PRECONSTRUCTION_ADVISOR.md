# Pre-Construction Advisor (Phase 1): source of truth

A module inside the existing Broko app (web and mobile browser). It is not a separate app, CRM or chatbot: Broko AI (the Central AI Brain) answers
questions about it through its existing chat. Nothing here sends email, books meetings, changes prices or inventory on its own, or deploys anything.

## Status (read this first)

| Area | State |
|---|---|
| UI, routes, navigation, mobile layout | Built. Verified in the demo backend (desktop and 375 px, no horizontal overflow). |
| Domain logic (upload checks, extraction, chunking, ingestion, inventory import) | Built and tested with real PDF / XLSX / CSV bytes, against an in-memory repository. |
| Brain integration (structured answers, citations, project context) | Built and tested. Deterministic: no model writes or reads any of it. |
| Supabase migration `0007` | **Written, NOT applied anywhere.** Verified only on a local PostgreSQL (68 checks). Lives in `supabase/proposed/`. |
| Supabase repository + Storage adapter | Written, contract-tested against a stub only. **Never run against a real Supabase project, PostgREST or Storage.** |
| Production | **Pre-Construction is not live.** The deployed site is demo mode (no database), so it shows clearly-labelled synthetic, read-only sample data. Real data needs migrations applied and verified on a dev project first (below). |

Do not call this production-ready until the "Before any real data" list is done.

## What exists

Navigation item **Pre-Construction Advisor** (building icon). Pages under `/precon`:

| Route | Purpose |
|---|---|
| `/precon` | Overview: persisted counts only (projects, active developments, inventory records, available units, documents, renderings), recent projects, empty states. |
| `/precon/projects` | Searchable directory. Filters: status, city. Sort: name, recently updated, expected completion. Administrators can include archived. |
| `/precon/projects/new`, `/[id]/edit` | Create / edit (administrators). |
| `/precon/projects/[id]` | Details, documents, inventory, "Ask Broko AI about this project", archive / restore (administrators). |
| `/precon/documents`, `/documents/[id]` | Documents and renderings: filter by project, type, status. Viewer: metadata, status, image preview, extracted text by page (`#p<n>` anchors used by AI citations), open / download (60-second signed link), reprocess, remove, replace. |
| `/precon/documents/[id]/file` | Authenticated redirect to a 60-second signed URL. 404 for "missing" and "not yours". |
| `/precon/inventory` | Search and filter (project, city, bedrooms, availability, price range, sort). Table on desktop, stacked cards below `lg`. |
| `/precon/import/[documentId]` | CSV / XLSX import wizard: column mapping, row-level validation, preview, then commit. |

## Who can do what

Conservative default (a business decision to confirm): **every signed-in user reads; administrators write.**

* Members read active projects, their documents, extracted text and inventory. Archived projects are visible to administrators only.
* Only administrators create / edit / archive projects, upload / remove / reprocess documents, import or verify inventory.
* `unit_number` is administrator-only (column privilege plus `precon_unit_numbers()`), and it is never put in an AI answer.
* The demo is read-only for everyone.
* Authorization is enforced three times: server actions (`requireUser` first, then `canManagePrecon`), the repository (the in-memory repository applies the same rules as RLS), and the database (RLS and column privileges in `0007`).

## Data model (migration `supabase/proposed/0007_preconstruction.proposed.sql`)

`precon_projects`, `precon_documents`, `precon_chunks` (text + generated `tsvector`, GIN index), `precon_inventory`, `precon_audit`; functions
`precon_search_chunks` (SECURITY INVOKER, websearch syntax) and `precon_unit_numbers` (SECURITY DEFINER, admin only, `search_path = ''`); private bucket
`precon-files` (25 MB, seven allowed MIME types) with read / insert / delete policies on `storage.objects`. RLS is enabled on every table; all privileges are
revoked and re-granted column by column; nothing is granted to `anon`; projects are archived, never deleted; the audit table is insert / select only and
holds no document text or prices. Follows the repo's migration conventions (role switch and restore, no drops). Rollback notes are at the end of the file.

## Files: upload, validation, ingestion

1. **Begin** (server action): validates project, name, size, extension and MIME against an allow-list (PDF, JPG, PNG, WebP, TXT, CSV, XLSX; no SVG, HTML, macros),
   creates a `pending` document row, returns a short-lived signed upload URL. The storage policy only accepts an object at the path of a `pending` row.
2. **Upload**: the browser PUTs the raw file straight to private storage with a progress bar (no file bytes pass through our server actions, so no body-size limit applies).
3. **Finish** (server action): downloads the object, checks magic bytes against the extension and (for XLSX) the decompressed size, hashes it, refuses an identical
   file in the same project, extracts text (PDF per page, plain text, spreadsheet rows), chunks it with page numbers, stores the chunks, and only then sets `processed`.
4. Rejections (unsupported, oversized, empty, content mismatch, duplicate, missing) delete both the row and the object. Extraction failures (scanned PDF with no text,
   encrypted or too complex) keep the document as `failed` with a fixed, user-safe reason and an administrator **Retry**. Images are stored and previewable, and say
   plainly that their content is not text-searchable (no OCR in Phase 1).
5. Status: `pending`, `processing`, `processed`, `failed`, `needs_reprocessing` (shown when the extractor version is newer than the one that processed the file).
6. Removal deletes the stored object **first**, then the row (chunks cascade). If storage fails nothing is deleted. Replacement uploads and processes the new file first,
   then removes the old one.
7. Filenames are sanitised for storage; two uploads with the same name land in different paths (`projects/<project>/<document>/<name>`).

## Inventory import

From an already-uploaded CSV / XLSX. Auto-maps headers, lets you correct the mapping, parses strictly (price, bedrooms incl. "Studio" and "1+Den", bathrooms, area, availability,
ISO dates, 3-letter currency), and classifies every row `new`, `duplicate`, `conflict` or `error` **before** anything is written. The server re-reads the stored file at
commit time; the browser never supplies row data. Default mode adds new records only. Updating conflicting records requires an explicit choice, never touches blank cells, and
resets verification. Rows with errors need an explicit "skip them" confirmation. Currency defaults to CAD when the file has none (stated in the UI). Imported records are
unverified until an administrator marks them verified. Limits: 2000 rows, 100 columns, 20 000 parsed rows, 2000 characters per cell.

## How Broko AI uses it (one Brain, no second chatbot)

Entry point unchanged: `askBroko` to `handleChat` to `askBrain`. After the existing injection / action / greeting rules, a deterministic parser
(`src/lib/ai-brain/chat/precon.ts`) recognises Pre-Construction questions **before** the model router, which therefore never sees them. No model writes any part of the answer.

* **Numbers** (prices, counts, availability, areas) come only from structured inventory queries through the user-scoped repository. They are never read out of document text.
  Units without a price never match a price question.
* **Document questions** (selling points, floor plans, completion, anything descriptive) use full-text retrieval over the chunks the user may see, and are labelled
  **unverified statements**, each with document title, page and a link to `/precon/documents/<id>#p<n>`.
* **Verified vs unverified**: inventory items say "verified <date>" or "not verified by a person"; records older than 90 days are flagged "may be outdated".
* **Conflicts**: years in completion / occupancy passages are compared with the project record and unit occupancy dates. A disagreement is stated, not resolved.
* **Missing / outdated**: computed (projects with no inventory, stale inventory, units without price or with unknown availability, projects with no processed documents).
* **Price source**: reports the inventory record's `source` and links its source document.
* **Nothing found** says so ("none are recorded, not that none exist"); nothing is estimated or invented. Pre-Construction not connected says "not connected".
* **Project context**: the button sends only a project id. The server validates it as a UUID and loads it through the user's repository on **every** question; an unknown, archived or
  not-permitted id gets the same "can't find that project" answer. The chat shows a visible "Answering about X only" chip.
* Existing controls are untouched: model routing, the 20-per-10-minutes limiter, the AI-mode unlock, fail-closed behaviour, the injection tripwire, and the rule that chat changes nothing.
  Retrieved text is treated as data and flagged if it looks like an instruction. No key or infrastructure detail reaches the browser (verified by scanning the production client bundles).

Example questions covered by tests: 2-bedroom availability, units under $800,000 (and ranges, `k` / `million`), key selling points, comparing floor plans, missing or outdated inventory,
the source document of a price, completion date (including a conflicting document).

## Environment

No new variables. Pre-Construction appears automatically where the Supabase backend is configured and `0007` has been applied. It uses the existing anon key and the signed-in
user's session only; **no service-role key is used or needed.** The document pages set `maxDuration = 60` because extraction runs in the finish step (Vercel Hobby allows up to 60 s;
a very large PDF may still time out, in which case it can be retried).

## Before any real data (required, in this order)

1. Apply `0001`, `0002`, `0006`, `0007` to a **development** Supabase project through the established process (see `docs/SUPABASE_CLI_ROLE_MODEL.md`). Nothing has been applied by this work.
2. Run the "STILL TO VERIFY" list at the end of `0007`: policies on `storage.objects`, signed upload and signed URL behaviour as administrator and as member, bucket MIME / size rejection.
3. Confirm the browser's direct PUT to the signed upload URL works (it sends the public anon key as `apikey`; the exact header requirement has not been confirmed against Storage).
4. Confirm the `profiles` embed on documents (`uploader`) and the column privileges through PostgREST.
5. Run an end-to-end upload, ingest, search, ask, authorize pass as an administrator, a member and a signed-out user. Then decide whether the permission defaults above are right.

## Tests

`tests/precon-files-extract.test.ts` (types, magic bytes, zip bombs, CSV, chunking, real PDF / XLSX extraction), `tests/precon-service.test.ts` (projects, upload, ingest, duplicates,
rejections and cleanup, reprocess, replace, remove ordering, permissions, import preview and commit, no silent overwrite), `tests/precon-brain.test.ts` (numeric grounding, citations,
conflicts, missing data, authorization, read-only, no hijacking of task questions, injection), `tests/precon-supabase-contract.test.ts` (columns and privileges the adapter asks for),
`tests/sql-security.test.ts` (static checks on `0007`), and `supabase/proposed/tests/0007_preconstruction.pglite.mjs` (68 executed RLS / privilege checks on a local PostgreSQL).

## Known limitations

* No end-to-end browser test framework exists in the repo; navigation, layout and the chat flow were verified by hand in a browser against the demo backend. Upload could not be exercised
  there (the demo has no storage), only through the service tests with real file bytes.
* No OCR: scanned PDFs and images are stored but not searchable. No DOCX / legacy XLS (rejected with a clear message).
* Search is Postgres full-text (English stemming). It finds words, not meaning; pgvector is a later option if this proves too literal.
* The question parser is keyword based. A phrasing it does not recognise falls through to the normal Brain (which may say it can't answer). It never guesses.
* Inventory is only as current as the last import or manual verification. "Verified" means a person confirmed the record, not that it is still true today.
* Authorization defaults (members read, administrators write, unit numbers admin-only) are a conservative choice awaiting business confirmation.
