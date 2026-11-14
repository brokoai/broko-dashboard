# Retention policy (draft)

Status: **draft recommendations, 2026-11-02. Nothing here is approved policy: decision D5 is unresolved and the periods below are recommendations awaiting the owner's approval and, after that, client and legal review. Nothing in this document is enforced by the system today.** There is no purge function and nobody (administrators included) has DELETE on these tables through the API, so data is currently kept until someone with owner-level database access removes it.

Scope: Broko's own Brain. The same policy would be the default for a future company's independent Brain, to be confirmed with that company.

## Recommended starting periods (not approved)

| Data | Table | Contains | Period | Basis |
| --- | --- | --- | --- | --- |
| Chat audit | `chat_audit` (0008, 0010) | Metadata only: intent, outcome, source ids, counts, latency, project id, actor id. No question, answer or record text. | **180 days** | Recommendation (D5 unresolved) |
| Answer feedback | `answer_feedback` (0009) | Rating, fixed reason, intent, source ids, actor id. No text. | **180 days** | Recommendation (D5 unresolved) |
| Knowledge events | `knowledge_events` (0009, 0011) | Who submitted, approved, rejected, expired, superseded or redacted an item, when, and a short reviewer note | **Life of the item** | Recommendation (D5 unresolved). It is the governance record for the item. |

## Not decided (no period has been approved)

These are listed so nobody assumes a default.

| Data | Table | State | Note |
| --- | --- | --- | --- |
| Knowledge items | `knowledge_items` | Kept; content removable by redaction once 0011 exists | A superseded or expired item keeps its row for history. Redaction (0011) blanks text but keeps the row. |
| Pre-Construction audit | `precon_audit` | Not defined | |
| Pre-Construction documents, extracted text, stored files | `precon_documents`, `precon_chunks`, bucket `precon-files` | Not defined. Company-owned business documents; retention is the company's decision. | Deleting a document is an administrator action in the app. |
| AI Inbox messages and jobs | `ai_messages`, `ai_jobs` (0003/0004) | **Tables not deployed.** Hold sender and subject. | Must be decided before the AI Inbox goes near real mail. |
| Tasks, activity, notifications | `tasks`, `activity_events`, `notifications` | Not defined | |
| Authentication records | Supabase Auth | Governed by Supabase and the company's settings. Not verified here. | |
| Backups | Supabase | Depends on the Supabase plan. **Not verified.** Redaction and deletion do not reach backups. | |

## Rules that hold regardless of period

1. **No conversation content is stored.** Chat history exists only in the browser tab. The audit stores metadata. This is a design property, not a retention setting, and is checked by a live test (Phase 3).
2. **Redaction is not retention.** Removing a leaked secret from a knowledge item is done now by redaction (once 0011 is applied), not by waiting for a period to end.
3. **Redaction keeps the record.** It blanks the item text, source note and topic and clears that item's history notes. The row, the status trail and the "redacted" event stay, so audits remain intact. It cannot reach backups, logs or an answer that quoted the item earlier.
4. **A purge is an event.** When a purge function exists it must be administrator-only, delete in bounded batches, and record how many rows were removed (not their content).
5. **Legal holds and client requests** override any period. The company decides; the Brain only provides the means.
6. **Offboarding** deletes the company's whole Brain (database, files, keys). With one database per company there is nothing to extract from a shared store.

## How it would be enforced (not built)

- If the owner approves a retention policy, a later and separately approved migration (none exists; no number is reserved) could add administrator-only `SECURITY DEFINER` purge functions for `chat_audit` and `answer_feedback` (cutoff 180 days), with a batch limit and a logged row count. They need their own tests and their own approval, and must not be combined with other changes.
- `knowledge_events` needs no purge: it follows the item. If an item itself is ever deleted by the owner, its events go with it.
- A scheduled run (Supabase scheduled job or an external trigger) is a separate decision and not assumed.
- Until then, state plainly to the company that retention is documented but not yet enforced.

## Review before use

- [ ] Periods confirmed with the company.
- [ ] Legal review of the periods and of the Anthropic data-processing position (chat questions may be sent to the model when AI mode is on).
- [ ] Undecided rows above assigned a period or an explicit "company decides".
- [ ] Purge functions built, tested and approved.
