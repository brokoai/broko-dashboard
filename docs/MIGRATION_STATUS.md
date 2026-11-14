# Migration status (broko-dev)

Scope: **Broko's own Brain only.** Broko is the only company being implemented; see `docs/CLIENT_DEPLOYMENT.md` for the future principle of one independent Brain per company.

**Evidence dates.** The "On broko-dev" column comes from a read-only check of the development project `broko-dev` (ref `olngcbgkxbceqpikcyxk`) on **2026-10-31**. It was **not repeated on 2026-11-02** (Phase 1 contacts no database). The 2026-11-02 pass only re-read the local files and recorded their hashes. Production Supabase and the project "brokoai's Project" (`esjloyhgipkdmdnvoiut`) were not touched by either check.

**The header comment inside each `supabase/proposed/*.sql` file says "PROPOSED, NOT APPLIED" and is not updated once a file is applied**, because editing an applied file would make it differ from what the database ran. This page, not the file header, says what is applied.

**Correction (before the consolidated commit): the "PROPOSED, NOT APPLIED" and "DRAFT, NOT APPLIED" headers in the `.proposed.sql` files are historical labels.** They record the state when each file was written and do **not** reflect the later application to `broko-dev`. Files 0009 to 0014 are all applied to **`broko-dev` only** (see the table below). **None of them is applied to production**, and "applied to broko-dev" must never be read as "deployed". The SQL files were not edited.

## Evidence levels used on this page

| Level | Meaning |
| --- | --- |
| **History row** | The migration-history table on `broko-dev` has a row for it. It does **not** prove the stored SQL equals the file. |
| **Stored SQL matches** | The statements stored in the database were compared with the file and match. |
| **Catalog audit** | A read-only catalog query set (`supabase/proposed/tests/*_catalog_audit.proposed.sql`) passed on the live project. |
| **Live-tested** | Behaviour exercised through real authenticated API sessions. |
| **Local only** | Executed on PGlite or by unit tests. Not proof of behaviour on Supabase. |

## Status by migration

| Migration | File hash (SHA-256, first 12) | On broko-dev (as of 2026-10-31) | Evidence level | Notes |
| --- | --- | --- | --- | --- |
| `0001_init` (in `supabase/migrations/`) | `19d6901cfd9a` | Applied | History row only | Holds the profile guard, `is_admin()`, `team_workload()` and the last-admin guard `profiles_keep_an_admin`. The security doc says 0001 was edited after its first review, so **the applied copy may be an older version**. Byte comparison outstanding. |
| `0002_hardening` | `0c3734822998` | Applied | History row only | Holds `tasks_guard` (the H-1 task-reassignment guard) and the integrations guard. Byte comparison outstanding. |
| `0003_ai_brain`, `0004_ai_jobs`, `0005_default_privileges` | `75653618922d`, `eab4de37e198`, `65e479aeb116` | **Not applied** | No history row | AI Inbox tables and the job queue. **Outside the Brain v1 set.** 0003 replaces `tasks_guard` from 0002 to let AI-created tasks through; that is not needed for Brain v1. |
| `0006_profiles_privacy` | `cc0d4e53b617` | Applied | History row only | Column-level SELECT on `profiles` without `email` (M-4). Byte comparison outstanding. |
| `0007_preconstruction` | `c96f083d235f` | Applied | History row only | Projects, documents, chunks, inventory, audit and the private `precon-files` bucket. Storage policies need a live check (open item in the file). |
| `0008_chat_audit` | `d560f6be2d4f` | Applied | **Stored SQL matches; live-tested 35/35** (reported by the owner, 2026-10-28; not re-run) | Metadata-only chat audit. Its header still says "NOT APPLIED" and is intentionally unchanged. |
| `0009_knowledge` | `998819733634` | Applied | Stored statements match; catalog audit passes. **Live-tested on `broko-dev` (Phase 3C run 2026-11-02) except D4, D5 (corrected assertion not rerun live), D6, D8.** Local PGlite 122 checks. | Three knowledge tables were empty at the time of the check. |
| `0010_chat_audit_vocab` | `4a40baf60444` | Applied | Stored statements match. **Live-tested on `broko-dev` (A5 passed); E5 blocked, covered by the read-only catalog audit.** | Adds the `knowledge` intent and source id. |
| **`0011_knowledge_guards`** | `58ae732df76c` | **Applied to `broko-dev` only (2026-11-02, Phase 3B Gate 1)** | Stored statements match; 0009 and 0011 catalog audits raise no exception. **Live-tested on `broko-dev` (Phase 3C run 2026-11-02: G1 and G8-G12 passed; G2 blocked, local PGlite only).** Local PGlite: 88 checks plus 10 that show the defect existed | Replacement scope/project/topic match; administrator-only content removal. Needs the owner's approval before it touches any database. |
| **`0012_knowledge_secret_check`** | `c337484d1d02` | **Applied to `broko-dev` only (2026-11-02, Phase 3B Gate 2)** | Stored statements match; 0012 catalog audit raises no exception. **Live-tested on `broko-dev` (Phase 3C run 2026-11-02: G3-G7 passed).** Local PGlite: 116 checks plus 10 before-state; shared corpus drift test; catalog audit with 12 mutations | Database triggers refusing 7 high-signal credential formats in title, body, topic, source note, review note and history note. A floor, not a detector. *(Historical note "needs the owner's approval before it touches any database": superseded, it was approved and applied to `broko-dev` only on 2026-11-02; production untouched.)* |
| **`0013_org_memory`** | `167b7a3e5d76` | **Applied to `broko-dev` only (2026-11-05)**; not applied to production | Migration history read 0001, 0002, 0006-0013 after the apply. **Catalog audit PASS 18/18 on broko-dev (owner-reported, 2026-11-11; raw rows not seen by the assistant).** Local PGlite 53/53. Authenticated live run (owner-reported 2026-11-12): 28 PASS / 2 FAIL (K1, K2) / 2 BLOCKED (R3, L2); see `docs/PHASE2A_COMPLETION.md` sections 11 and 12. | Persistent organizational memory (Phase 2A). **Phase 2A is NOT COMPLETE**; production acceptance is deferred to the go-live checklist. |
| **`0014_org_relationships`** | `afc0b546ea65` | **Applied to `broko-dev` only (2026-11-12)**; not applied to production | **Catalog audit PASS 18/18 on broko-dev** (database level only). Local PGlite 102/102. **Live relationship behaviour is UNVERIFIED**; the controlled write test has not run and `BROKO_ORG_RELATIONSHIPS` stays off. | Organizational relationships (Phase 2B). Not production-ready; checklist `docs/PHASE2B_GO_LIVE_ACCEPTANCE.md` is NOT STARTED. |

## Brain v1 migration set and apply order

This is the set a Brain v1 database needs. It is the same set for Broko's own database now and for any future company's independent Brain.

```
0001 → 0002 → 0006 → 0007 → 0008 → 0009 → 0010 → 0011 → 0012
```

Organizational memory and relationships (Phase 2A and 2B) are applied on top of it, on `broko-dev` only: `… → 0012 → 0013 → 0014`.

`0003`, `0004` and `0005` are **excluded** (AI Inbox and the job queue; deferred to the integrations phase). Numbers are not contiguous on purpose. New migrations never reuse a number and never edit an applied file.

Applied to `broko-dev` only (2026-11-02); production is untouched:

| Draft | Purpose | Status |
| --- | --- | --- |
| 0012 knowledge secret check | Database check for high-signal secret patterns in knowledge text, so a direct API insert cannot bypass the app's screen | **Applied to `broko-dev` only (2026-11-02)**; not applied to production. (An earlier version of this row said "Local draft and local tests only"; that was outdated and is corrected.) |

**Unresolved owner decisions that could add migrations** (D3–D6 in `docs/ADR_BRAIN_V1_DECISIONS.md`): restricting `team_workload()` (D4), a second-reviewer rule (D6), retention purge functions (D5), project-level access (D3). **No migration file exists for any of them and none is planned until the owner decides.** Their proposals are not policy.

## Dependency matrix

| Migration | Requires (objects it uses) | Needed by | Rollback independent? |
| --- | --- | --- | --- |
| 0001 | none (Supabase `auth.users`) | everything | no |
| 0002 | 0001 (`tasks`, `integrations`, `is_admin`) | 0003 | **no**, 0003 replaces its `tasks_guard` |
| 0006 | 0001 (`profiles`) | the app's profile reads | yes (restore the SELECT grant) |
| 0007 | 0001 (`is_admin`, `touch_updated_at`, `profiles`) | 0009 (`precon_projects` visibility) | yes, but destroys Pre-Construction data |
| 0008 | 0001 | 0010 | yes (destroys audit rows) |
| 0009 | 0001, **0007** | 0011, 0010's vocabulary | yes (destroys knowledge) |
| 0010 | **0008** (and mirrors 0009's vocabulary) | the Knowledge intent in chat audit | yes |
| 0011 | **0009** | 0012 | per-step; content already removed is not recoverable |
| 0012 (applied to broko-dev only) | 0009 and 0011 (written to follow 0011; not tested without it) | none | yes (drop both triggers and both functions) |
| 0013 (applied to broko-dev only) | 0001, 0009 (`knowledge_items`) | 0014 | yes (destroys stored sources, records and review history) |
| 0014 (applied to broko-dev only) | 0001, 0013 (`org_source_docs`, `org_entities`, `org_memory_guard()`) | none | yes (destroys stored relationships and review history) |

Knowledge therefore depends on Pre-Construction (0009 needs 0007), so a Brain v1 database always includes the Pre-Construction tables.

## Reconciliation of contradictory documents

| Claim | Where | Verified position (2026-11-02) |
| --- | --- | --- |
| "Nothing has been applied to any remote database" | `docs/SUPABASE_SECURITY_STATUS.md` (written 2026-10-25) | **Outdated.** By the 2026-10-31 check, 0001, 0002, 0006, 0007, 0008, 0009 and 0010 have history rows on `broko-dev`. 0003–0005 are not applied. 0011 and 0012 were applied to `broko-dev` on 2026-11-02 (after that check). |
| H-1 (task reassignment) is in "0002/0003" | `docs/SUPABASE_SECURITY_STATUS.md` | The guard is created by **0002** (`tasks_guard`). 0003 only replaces it. 0002 has a history row on dev; the stored function has not been compared. |
| M-4 (`profiles.email` visible) fixed by 0006 | same | 0006 has a history row on dev; the stored grant has not been compared. |
| L-6 / M-2 (last admin, first-admin promotion) "in the file, unapplied" | same | They are in `0001_init.sql`, which has a history row on dev. Whether the applied copy includes them is **not verified**. |
| M-5 (`team_workload()` open) | same | **Still open.** Restricting it to administrators is an unresolved proposal (D4); nothing is written or applied. |
| M-6 (public sign-ups) | same | **Not verified** on any project. |
| "No audit log of chat questions" | `docs/ai-brain/CHAT.md` | **Outdated.** 0008 and the chat audit writer exist and were live-tested on dev (owner-reported). The file's other statements are dated and are marked there. |
| An administrator may approve their own submission | `docs/KNOWLEDGE_MEMORY.md` decision 2 | Still **true of the code and database today**. A second-reviewer rule is an unresolved proposal (D6); see the decision record. |

## Verification debts (nothing here is proven yet)

1. Byte comparison of the stored SQL of 0001, 0002, 0006 and 0007 with the files above (read-only). Requires approval to contact `broko-dev`.
2. Live test of 0009 and 0010 behaviour: done on `broko-dev` (see item 6); remaining are the corrected D5 rerun and the blocked checks D4, D6, D8, E5, G2. Any rerun of `--execute` needs the owner's explicit approval.
3. Live checks for the task guard, the `profiles.email` column, `team_workload()` and the last-admin guard.
4. Storage policies for `precon-files`.
5. Sign-up policy of the Auth project (M-6).
6. 0011 and 0012 are applied to `broko-dev` only (not production), structurally verified by read-only queries. Their behaviour under real PostgREST sessions was tested live on `broko-dev` only (Phase 3C, run `20261102192712-cf03d6`): **51 passed, 1 failed, 5 blocked.** The sole failure was D5: the live database correctly refused a project-scope insert with SQLSTATE 42501 (RLS) while the test expected only 23514; the assertion was corrected locally to accept either and has passed local tests but **has not been rerun against Supabase**. Still not live verified: D4, D6, D8, E5, G2 (blocked; reasons in `docs/KNOWLEDGE_MEMORY.md`). Cleanup passed; no proposed or approved test record remains; `chat_audit` unchanged at 121.
7. Current `broko-dev` baseline after that run: knowledge_items 42, knowledge_events 112, answer_feedback 2, chat_audit 121 (next run needs `KNOWLEDGE_LIVE_EXPECT_ROWS="42,112,2"`). The test rows are terminal and not purged.

## Rules for applied files

- Never edit an applied migration file. Add a new numbered migration instead.
- `tests/knowledge-app.test.ts` pins the SHA-256 of the 0009 and 0010 files, so an accidental edit fails the test suite.
- After any apply, record it here and run the matching read-only catalog audit in `supabase/proposed/tests/`.
- Apply one migration at a time. Never combine database changes.
