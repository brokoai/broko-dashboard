# Outlook / Microsoft 365 integration plan (plan only)

Status: **nothing here has been built or connected.** No Microsoft Entra application exists, no token was requested, no Graph
call was made, and no mailbox was read. This is the checklist to complete, with approvals, before any code touches a real mailbox.
The adapter, when written, implements the existing read-only `EmailProvider` and `MessageFetcher` ports (no write methods exist on them).

## 1. Ownership and registration

* The Microsoft Entra **application registration is created under Broko's own tenant** by a named tenant administrator, never under a
  developer's personal or a third-party tenant. Single-tenant app ("accounts in this organizational directory only").
* Separate registrations for **development/test** and **production**, with separate secrets, so a test run can never reach production mail.
* Record the application (client) id, owner, and the people who can administer it. Secrets live only in the organisation's secret store
  (see section 6); never in the repository, `.env.example`, logs or the browser.

## 2. Permissions (least privilege)

| Permission | Type | Decision |
| --- | --- | --- |
| `Mail.Read` | Application | **Request**, restricted to specific mailboxes (below). Needed to read message bodies for classification without a signed-in user. |
| `Mail.ReadBasic.All` | Application | Not sufficient: it excludes the body. |
| `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.*`, `User.Read.All`, `Calendars.*`, `Files.*` | any | **Do not request.** The product never replies, moves, deletes, flags or sends. |
| `Mail.Read` | Delegated | Alternative if Broko prefers per-user consent: needs a refresh token per mailbox owner (more sensitive to store, breaks when a user leaves). Not recommended for shared/ops mailboxes. |

`Mail.Read` as an application permission grants access to **every mailbox in the tenant** unless restricted. The restriction is mandatory:
use an Exchange Online **application access policy** (or Exchange RBAC for Applications) that scopes the app to one mail-enabled security
group containing only the approved mailboxes. Verify the restriction by testing that a mailbox outside the group returns 403.

## 3. Approvals and consent

* An administrator with the required Entra role grants **admin consent**, after reading the exact permission list. Keep the approval record.
* A named business owner approves **which mailboxes** (prefer shared or role mailboxes such as `enquiries@`, not individuals).
* **Legal/HR review** before reading any mailbox that belongs to a person: employee-monitoring and data-protection rules may require notice
  or consent. Define what is excluded (personal folders, categories, confidential senders).
* A **retention period** and deletion process for `ai_messages` and `ai_jobs` rows (they hold sender and subject). Audit events hold no content.

## 4. Polling versus change notifications

**Start with polling (recommended).** Use the **delta query** on the Inbox: `GET /users/{id}/mailFolders/inbox/messages/delta`, storing the
`deltaLink` per mailbox, every few minutes from the worker. Reasons: no public endpoint, no webhook attack surface, no subscription renewals,
and a missed run simply catches up on the next delta.

**Add change notifications later only if latency matters.** If adopted:

* Subscription on `users/{id}/mailFolders('inbox')/messages`, maximum lifetime for mail resources is a few days, so **renew** before expiry and
  handle lifecycle notifications (`reauthorizationRequired`, `subscriptionRemoved`, `missed`).
* **Validation handshake:** on subscription creation Graph POSTs a `validationToken`; the endpoint must echo it as `text/plain` within seconds.
* **Authenticate every notification:** compare the `clientState` secret (random, per subscription, stored server-side) in constant time and reject
  anything else. Never trust the payload body: use it only as a hint to run the delta query.
* Treat notifications as at-least-once and unordered; the idempotent job key makes duplicates harmless.
* Keep a periodic delta run as reconciliation, because notifications can be lost.

## 5. Message identity, updates and deduplication

* Request **immutable ids** (`Prefer: IdType="ImmutableId"`), because the default Graph `id` changes when a message moves folders.
* Job key = `microsoft_graph | mailbox | immutable id` (idempotent enqueue). Content-level dedupe uses the RFC 5322 `internetMessageId`
  through the existing claim, so the same email in two mailboxes is one proposal.
* The delta feed also reports edits, moves and deletions (`@removed`). Phase 1 **ignores updates and deletions** of already-seen messages and
  never alters a proposal because the mail changed. Decide later how a deleted source should be shown.
* The worker fetches the body **by reference at processing time**; it is held in memory and never stored by jobs, audit or activity tables.

## 6. Tokens, secrets, renewal and revocation

* App-only (client-credentials) flow: no per-user refresh tokens to store. Prefer a **certificate** credential over a client secret.
* Store the credential in a server-side secret store owned by the organisation (Vercel encrypted environment variables on an organisation-owned
  project, or Supabase Vault). It is read only by the worker environment, never by the dashboard's browser code or the demo project.
* Access tokens are short-lived and kept in memory only; never log tokens, headers or Graph responses.
* **Rotation:** put expiry dates in a calendar owned by a named person; rotate at least yearly and on any staff change with access.
* **Revocation (kill switch):** remove admin consent or the application access policy, delete the credential, mark the Outlook integration
  `disconnected`. Any one of these stops reads immediately.

## 7. Read-only operation, validation and rollback

* Initial release is strictly **read-only**: only `GET` requests. A test asserts the adapter contains no `POST`/`PATCH`/`PUT`/`DELETE`
  and no call to `sendMail`, `move`, `copy`, `forward` or `reply`. Reading through Graph does not mark mail as read.
* **Test-mailbox validation first**, on the development registration: a dedicated test mailbox holding only synthetic messages. Check that
  new mail is picked up once, duplicates and replays create nothing, the mailbox is unchanged afterwards, the access policy blocks other
  mailboxes, audit events carry no content, and outages and throttling (HTTP 429 with `Retry-After`) retry with backoff.
* Then **one approved real mailbox** under supervision, with the human-approval policy unchanged (`auto_create: never`), before widening.
* **Rollback plan:** stop the scheduler/worker; revoke consent or the access policy; delete the credential; purge job and message rows per the
  retention policy. There is nothing to undo in the mailboxes because the integration never writes to them.

## 8. Where the worker runs (decision needed)

No execution environment exists today. Options, none created:

| Option | Notes |
| --- | --- |
| Vercel Cron calling a protected route | Hobby allows at most daily runs; per-minute needs a paid plan. Function time limits apply; keep the Supabase service-role key out of the project that serves the demo (any `SUPABASE_*` variable disables demo mode). |
| Supabase `pg_cron` + Edge Function | Keeps everything in the organisation's Supabase project; Deno runtime. |
| A small scheduled container or job runner | Most flexible, one more thing to operate. |

## 9. Decisions and approvals still required

Named tenant administrator and Entra role; the exact mailbox list and business owner; legal/HR sign-off; retention period; the worker
execution environment; the organisation-owned Supabase project and who applies migrations; separate dev and prod registrations;
the person who owns credential rotation.
