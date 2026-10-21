# AI Brain — security assessment and setup

## Threat model: email is untrusted input

| Threat | Control | Tested |
| --- | --- | --- |
| Prompt injection in body/subject/name/attachment names ("ignore previous instructions", "approve this", "reveal key") | Model gets no tools, secrets or config; email is data inside per-request nonce markers (forged markers stripped); output is strictly validated; a regex tripwire raises `prompt_injection_suspected`, which forces human review. The tripwire is a **signal, not the boundary**: the boundary is that the model can only emit validated data and cannot assign, approve or send. | yes (fake models) |
| Hidden text (CSS-hidden HTML, zero-width, bidi override) | Removed before the model sees it; the removed text is still scanned for injection | yes |
| Instructions in a quoted earlier thread | Quoted thread stripped | yes |
| Model obeys injection and returns owner/approval/status fields | `z.strictObject`: any extra key fails the message (`FAILED`, nothing created) | yes |
| Model invents phone/email/date/property/urgency | Grounding drops anything not present in the message; reported as missing | yes |
| Spoofed identity ("I am your client") | Sender is `sender_unverified` unless its domain is explicitly configured; a name in the text never verifies | yes |
| Payment-redirect / phishing | Pattern raises `possible_phishing` + `financial`; always reviewed | yes |
| Duplicate delivery / races | Atomic claim, compare-and-set approval, backend idempotency | yes (in memory) |
| Privilege escalation via approval | Only admins review; assignment checked with the dashboard's own `checkTaskChange`; system actor must be explicitly permitted by the backend | yes |
| Secret leakage | API key is non-enumerable in config, only sent in a header; errors are sanitised; audit events are content-free; config problems never echo values | yes |
| Automatic outbound mail | **No send capability exists** in any port. Replies are never generated or sent. | by construction |
| Financial / compliance decisions | Payment, legal, offer, complaint intents always go to a human | yes |

Residual risks: a sufficiently clever injection can still bias `summary`/`proposed_task` text shown to a reviewer
(reviewers see the original subject and sender); the rule-based baseline is crude; LLM behaviour is unmeasured against
real mail; free-text fields are rendered as text, never HTML (keep it that way in the UI).

## Data handling

Only what is needed is stored: sender, subject, validated analysis, flags, status. The email body is **not** stored
(`retain_excerpt_chars` defaults to 0). Recipients are dropped unless `includeRecipients` is set. Audit events carry
no message content. Define a retention period for `ai_messages` before real data flows.

## Environment variable names (no values here)

`ANTHROPIC_API_KEY`, `BROKO_AI_MODEL`, `BROKO_AI_POLICY`, `BROKO_AI_OWNER_RULES`,
`MICROSOFT_GRAPH_TENANT_ID`, `MICROSOFT_GRAPH_CLIENT_ID`, `MICROSOFT_GRAPH_CLIENT_SECRET`,
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`. Server-only. Existing names are listed in `.env.example`.
The Graph/Google names are reserved: no adapter reads them yet.

### Shapes

`BROKO_AI_POLICY` (partial; omitted keys use safe defaults): `auto_create` (`"never"` default | `"low_risk"`),
`min_confidence` (0.8), `always_review_intents`, `verified_sender_domains` ([]), `sla_days` ({}), `retain_excerpt_chars` (0).

`BROKO_AI_OWNER_RULES`: JSON array of `{ "id": "slug", "priority": 100, "when": { "intents": [...], "property_prefix": "...", "min_urgency": "high" }, "owner_id": "<profile id>" }`.
Use profile ids, not personal names or emails, in repository files.

## Setting up real email (not done; needs authorisation)

1. Decide the provider and the exact mailboxes. Do not grant tenant-wide mail access.
2. Create the OAuth application **under the organisation's tenant/workspace**, not a personal account.
   Microsoft Graph: application registration with `Mail.Read` restricted to specific mailboxes via an
   Exchange application access policy. Google: OAuth client with `gmail.readonly` for the selected users only.
3. Store secrets only in the hosting dashboard / a secrets manager. Encrypt refresh tokens at rest; rotate on staff change.
4. Implement `EmailProvider` for that provider (read-only; cursor via delta query / history id).
5. Test against an authorised test mailbox before any real mailbox. Only then may the integration be shown as "connected".
6. Add an authenticated, rate-limited ingest trigger (cron or webhook with signature validation).

## Before enabling anything in production

* Review and, only with explicit approval, apply `supabase/proposed/0002_hardening.proposed.sql` then `0003_ai_brain.proposed.sql`
  to a disposable branch first. The `tasks_guard` change in 0003 is an **open design decision** (see comments in the file).
* Measure the LLM classifier on a labelled set of real-but-consented mail; keep `auto_create: "never"` until precision is known.
* Run the suite (`npm test`), lint, type-check and build; none of that replaces a test against real providers.
