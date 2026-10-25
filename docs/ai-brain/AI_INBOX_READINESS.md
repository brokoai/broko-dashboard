# AI Inbox: read-only readiness for real-backend verification

**Status: code and documentation only.** No Supabase project was contacted, no SQL was run, no migration was applied or renamed,
no auth setting, user or role was touched, and Vercel was not changed. Nothing here is production-ready; it is ready for review.

Related: `docs/ai-brain/REMOTE_VERIFICATION_CHECKLIST.md` (procedure and order), `docs/ai-brain/CHAT.md`, `docs/ai-brain/INTEGRATION.md`.

## 1. What changed in the code

The AI Inbox repository used to be one optional interface (`Repo.aiInbox`) that bundled reading with `process / requeue / review`.
Any backend that had it automatically got approve, reject, "Process queue now" and "Retry" in the UI. It is now split:

| Capability | Interface | `Repo` field | Who has it today |
| --- | --- | --- | --- |
| Page data (messages, jobs, queue) | `AiInboxReader` (`view()`) | `aiInbox` | demo only |
| Status counts for chat | `AiInboxCountsReader` (`counts()`) | `aiInboxCounts` | demo only |
| Approve / reject / process / requeue | `AiInboxWriter` | `aiInboxWriter` | demo only |

* The **Supabase backend provides none of the three**. The AI Inbox page says "not connected"; chat says "not connected".
* The page shows approve / reject / assign, "Process queue now" and "Retry" **only when `aiInboxWriter` exists**. Without it the page
  renders a "Read-only view" banner, lists messages, and never starts the background worker. The three server actions
  (`src/app/(app)/inbox/actions.ts`) use `aiInboxWriter` only, so a read-only backend cannot be driven through them either.
* Demo vs live is explicit: `AiInboxView.mode` / `AiInboxCounts.mode` is `"synthetic"` (banner: "Synthetic sample messages. This is
  not a live mailbox.") or `"live"` (banner: "Live data from your database."). A missing live source is reported as not connected or
  unavailable, never filled with demo data.
* **Chat reads counts only.** `aiInboxAdapter` (`src/lib/ai-brain/chat/retrieval.ts`) checks the administrator role first, then calls
  `aiInboxCounts.counts()`. It never calls `view()`, so subjects, sender addresses, excerpts and bodies cannot reach chat.
  A member is refused before any reader is touched and cannot infer a count. A read failure is "unavailable" with no count.
* `src/lib/backend/supabase/ai-inbox-counts.ts` is a **prepared, unwired** reader for the future live backend: administrator check
  before any query, selects the single column `status` from `ai_messages`, refuses to undercount at 10,000 rows. It is not reachable
  from the running app; it exists so the minimal-column behaviour is reviewed and tested before anything is switched on. It needs
  migration 0003 and an owner decision (section 4). **Nothing in this repo claims a live repository is available.**

## 2. Migration documentation corrections (comments and docs only; no file renamed, moved or applied)

* `0002_hardening.proposed.sql` header: the old text said 0001 "raises for EVERY caller that is not an admin session". The current
  0001 guard already lets `auth.uid() is null` through; 0002 adds the email check. The comment is corrected (a comment-only change,
  so the file's SHA-256 differs from any hash recorded earlier; re-record hashes before an approval). The header now also states that
  0003 replaces `tasks_guard`.
* `REMOTE_VERIFICATION_CHECKLIST.md`: order is now 0001 -> 0002 -> 0003 -> 0004 -> 0006 in one push (0005 excluded); hard
  dependencies listed; rollback implications per file; the unique-index attribution fixed (it is 0003, not 0002).

## 3. Unresolved: `tasks_guard` and SECURITY DEFINER (0003)

0003 replaces 0002's `tasks_guard` with a **SECURITY INVOKER** function that decides `source` from
`current_user not in ('authenticated','anon')`. The design relies on `ai_approve_message` (SECURITY DEFINER, admin-checked first,
owned by a privileged role) being the only code that inserts tasks as a different role, so only it can set `source='email'`.
Verified: PGlite and a local PostgreSQL only. **Not verified on Supabase**, where these are still open (they are listed in the file
itself):

1. `current_user` inside a trigger fired by a SECURITY DEFINER function is the definer (expected, unproven on Supabase).
2. `is_admin()` still works from an invoker trigger.
3. The function owner is not `authenticated`/`anon` and cannot be assumed by clients.
4. Whether the owner should be a dedicated NOLOGIN role rather than `postgres`.

Consequence if wrong: either approval fails (safe, visible), or a client could set `source` (task provenance forgery). Verify on a
disposable branch before approving 0003. Do not rely on this until then.

## 4. Decisions that are the owner's, not made here

| Id | Decision | Recommendation | State |
| --- | --- | --- | --- |
| M-5 | Who may call `team_workload()` (currently any signed-in user sees every member's counts) | Admin-only, or own row for members | **Explicit approval needed.** Open. |
| M-6 | Public sign-up on the Supabase project (the `handle_new_user` trigger gives every new auth user a profile) | Disabled / invite-only before launch | **Explicit approval needed.** Open; deferred by the owner for now. Not checked or changed. |
| Set | Approve the migration set and the order in the checklist | 0001, 0002, 0003, 0004, 0006 | Open. |
| 0003/0004 | Whether the AI Inbox is in scope at all | In scope only with the live integration | **Still NOT APPROVED FOR APPLICATION.** |
| 0005 | Default-privileges change | Excluded from this milestone | Separate decision. |
| Wiring | Enable `createSupabaseAiInboxCounts` on the Supabase repo; any live `AiInboxReader`; any `AiInboxWriter` | Counts first, writer last | Needs 0003 applied and verified, plus approval. |
| CLI | Filenames without `.proposed`, `supabase/config.toml`, behaviour of CLI 2.122 | Verify on a disposable branch | Unverified. |

## 5. Steps that need separate owner approval (none was taken)

1. Approve the target (`broko-dev`, ref `olngcbgkxbceqpikcyxk`, never `esjloyhgipkdmdnvoiut`) and the migration set and order.
2. Decide M-5 and M-6; decide whether 0003/0004 are in scope.
3. Verify on a disposable branch: the `tasks_guard` points in section 3, two-session behaviour, `current_user` semantics.
4. Convert the proposed files into migrations (naming, config) and run the single ordered push.
5. Wire the counts reader (then a page reader, then a writer), each with its own integration tests against the real database.
6. Only then change Vercel public Supabase variables or create the first admin.
