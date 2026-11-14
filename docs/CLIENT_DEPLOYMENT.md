# Independent Brain per company: deployment principle

Status: **design principle, recorded 2026-11-02. Nothing in this document has been provisioned or executed.** Broko is the only company being implemented. This is Broko's own independent AI Brain. The sections below describe how any future company would be deployed so that today's choices do not block it.

## The principle

Every company gets its own complete, independent Brain. **Nothing is shared between companies**: not knowledge, not organizational memory, not a database, not credentials, not a rate-limit store.

Broko is **not** building a multi-tenant system. There is no organization table, no tenant switch and no cross-company query path, and none will be added for this purpose. The `organization_id` columns reserved in `chat_audit`, `knowledge_items` and `answer_feedback` stay unused.

## What one Brain consists of

| Layer | One per company | Today (Broko) |
| --- | --- | --- |
| Application deployment (Vercel project) | yes | The existing Broko Vercel project. Production currently runs the synthetic demo. |
| Supabase project (database, Auth, Storage) | yes | `broko-dev` for development. Another project in the organisation ("brokoai's Project") exists; its role is not verified here and it is not touched. The production app does not use any Supabase project yet. |
| Knowledge base | yes (lives in that database) | Empty tables on `broko-dev` |
| Redis (spend and unlock limits) | yes, at least a distinct key prefix and token | Not configured in production, so the model path is off |
| Anthropic credentials | yes | Not configured in production |
| Integrations (Microsoft, Google, WhatsApp) | yes: that company's own tenant and consent | None connected |
| Configuration (AI policy, owner rules, model, limits) | yes | Environment variables only |
| Users, roles, first administrator | yes | Demo accounts only in production |

## Rules that follow from the principle

1. **No shared database, ever.** Two companies never share a Supabase project, even with row filters.
2. **No shared credentials.** Supabase keys, Anthropic keys, Redis tokens, OAuth clients and the demo/unlock secrets are created per company and never reused. A secret that leaks affects one company.
3. **No knowledge crosses companies.** Knowledge, corrections and feedback are never copied or summarized from one Brain into another. If starter content is ever offered, it must be generic, reviewed and added through the normal proposal and approval path.
4. **One codebase, one migration set.** The same repository and the Brain v1 migration set (`docs/MIGRATION_STATUS.md`) apply to every company. A company never gets a private fork of the schema.
5. **Per-company namespacing in code.** The Redis key prefix today is `broko:chat:<VERCEL_ENV>`. A future company deployment must add a company slug to it (a code change, Phase 4, not done now) so a shared Redis could never mix counters even by mistake.
6. **The service-role key is not used.** The application uses only the publishable key plus the signed-in user's session. `SUPABASE_SERVICE_ROLE_KEY` in `.env.example` is reserved and unused; keep it out of the app environment.
7. **Roles stay inside the database.** Roles change only through the database (the first administrator by the bootstrap procedure, later through administrators). Never from the browser.
8. **Documentation of the boundary.** Customer-facing descriptions must say what project access is and that the Brain never uses another company's information. Project access today is: every signed-in employee sees active projects, archived ones are hidden from non-administrators. Whether that is the intended model is an unresolved owner decision (D3, proposed Model A).

## Future onboarding procedure (not executed; each step needs the owner's approval when it is first used)

Prerequisites: the Brain v1 release blocker list is closed.

1. **Create the company's accounts** under the company's (or the agency's) own organizations: Supabase project, Vercel project, Redis database, Anthropic API key with its own spend limit. Record the references in the company's deployment record (see below).
2. **Configure Auth** on the new Supabase project: disable public sign-ups (invite only), set password policy and rate limits, set the site URL and redirect URLs. Record that each was checked.
3. **Apply the Brain v1 migration set** one file at a time in the order in `docs/MIGRATION_STATUS.md`, running the matching read-only catalog audit after each. Never apply a file that is not in the set.
4. **Set the Vercel environment** (server-side only): `NEXT_PUBLIC_SUPABASE_URL`, the publishable key, `ANTHROPIC_API_KEY`, `BROKO_AI_CHAT` as decided, the Redis variables, the company slug. Leave `BROKO_DEMO_MODE` unset. Demo mode is impossible once any Supabase variable exists.
5. **Create the first administrator** by the bootstrap procedure in `docs/SUPABASE_SECURITY_STATUS.md` (invite through Supabase Auth, then promote with SQL run as `postgres`, then verify by signing in). Create a second administrator as soon as practical (a second-reviewer rule is an unresolved proposal, D6).
6. **Smoke-test read-only:** sign-in works; a member cannot reach administrator views; the assistant answers with source labels; knowledge can be proposed and an administrator can review it; chat audit rows appear and carry no text.
7. **Hand over:** deployment record completed; retention periods confirmed with the company (`docs/RETENTION.md`).

Offboarding: delete the company's Supabase project, Vercel project, Redis database and Anthropic key; revoke OAuth consent in its tenant. Because nothing is shared, deletion is complete by construction. Backups are covered by the provider's own retention (not verified here).

## Deployment record (kept outside this public repository)

One record per company, stored privately. While the repository is public, **no company identifier, project reference or credential belongs in it**. Fields: company, owner contact, administrators, Supabase project reference and region, Vercel project, Redis database, Anthropic key label and spend limit, release version deployed, migrations applied with date and evidence, Auth settings checked with date, sole-administrator exceptions and their reviews, retention agreed.

## What this document does not authorize

No new Vercel project, Supabase project, Redis instance or Anthropic account is to be created. No existing Broko environment or deployment changes. A fresh-project replay of the migration set, which would prove the procedure, needs its own approval.
