# CI implementation proposal

Status: **proposal only, 2026-11-02. No workflow file exists and no GitHub setting has been changed.** Today there is no `.github` directory, so nothing runs automatically.

## Goals

Run the same checks the team runs by hand, on every pull request and on pushes to the main branches, and make the security checks required before merge. CI must never contact a database or hold any secret.

## Facts this proposal rests on (verified locally 2026-11-02)

- Scripts in `package.json`: `lint` (`eslint`), `typecheck` (`next typegen && tsc --noEmit`), `test` (`node --conditions=react-server --import tsx --test tests/*.test.ts`), `build` (`next build`).
- The live scripts are `tests/live/*.script.ts`. They do not match `tests/*.test.ts`, so `npm test` never runs them.
- Ten PGlite scripts in `supabase/proposed/tests/*.pglite.mjs` (exit codes are set with `process.exit`). They need `@electric-sql/pglite`, which is **not** in `package.json` (they say `npm install --no-save @electric-sql/pglite`). The locally installed version is 0.5.11.
- `engines.node` of the repository's Next.js is `>=20.9.0`; the local machine runs Node 24.
- No `package.json` `engines` field of its own.

## Proposed workflow

One workflow, `ci.yml`, triggered by `pull_request` and by `push` to `main` (and release branches). It does **not** use `pull_request_target`.

| Job | Command | Required check |
| --- | --- | --- |
| lint | `npm ci` then `npm run lint` | yes |
| typecheck | `npm ci` then `npm run typecheck` | yes |
| unit-tests | `npm ci` then `npm test` | yes |
| sql-tests | `npm ci`, then `npm install --no-save @electric-sql/pglite@0.5.11`, then each `supabase/proposed/tests/*.pglite.mjs` | yes |
| security-regression | the security tests below, run as a named subset of `npm test`, so a failure is visible by name | yes |
| build | `npm run build` | yes, once verified (see risks) |
| secret-scan | a secret scanner over the working tree and history | yes |
| dependency-audit | `npm audit --omit=dev --audit-level=high` | advisory at first |

Settings:
- `permissions: contents: read` only.
- No repository secrets are used. Provide no `SUPABASE_*`, `ANTHROPIC_API_KEY` or Redis variables. Tests use fakes and PGlite.
- Node: use the active LTS (22 proposed), verified against the `>=20.9.0` requirement. Pin third-party actions by full commit SHA at implementation time (not looked up now).
- Cache the npm download cache only. No build caches that could carry state between runs.
- Concurrency: cancel superseded runs on the same branch.
- Live scripts are **excluded** from CI by design. A guard job fails if any workflow file mentions `--execute`, `PRECON_LIVE_CONFIRM` or a Supabase URL.

## Security regression subset (existing tests worth naming)

| Area | Tests |
| --- | --- |
| Authorization and roles | `tests/permissions.test.ts`, `tests/demo-security.test.ts`, `tests/supabase-grants-contract.test.ts` |
| SQL privileges | `tests/sql-security.test.ts`, all PGlite scripts |
| Knowledge governance | `tests/knowledge.test.ts`, `tests/knowledge-replacement.test.ts`, `tests/knowledge-app.test.ts` (pins the 0009/0010 hashes), `tests/knowledge-supabase-contract.test.ts` |
| Chat safety, audit, spend | `tests/chat-audit.test.ts`, `tests/ai-chat*.test.ts`, `tests/ai-unlock.test.ts` |
| Injection and untrusted content | `tests/ai-brain-rules.test.ts`, `tests/ai-brain-classifier.test.ts`, `tests/precon-brain.test.ts` |
| Live-script safety | `tests/knowledge-live-script.test.ts` |

A new `security-eval` set (Phase 5) adds authorization-bypass, injection-corpus, secret-leakage and retrieval-correctness cases and joins this list.

## Branch protection (settings for the repository owner to apply; not changed here)

- Require the pull request, the required checks above and an up-to-date branch before merge.
- Require at least one review; block force pushes and deletion of the protected branches.
- Restrict who may bypass.

## Risks and unknowns

1. `next build` may need environment variables or may behave differently without them. Unverified; run it once in a throwaway local check before making it required.
2. Private-repository Actions minutes are limited on free plans (relevant if the repository goes private, D2).
3. PGlite scripts take time; measure before deciding to run all ten on every push.
4. A secret scanner may flag the credential-shaped test fixtures (`sk-ant-TEST…`, alphabet strings). An allowlist is needed, with a review of each entry.
5. Pinning actions by SHA requires someone to update them. Pair with Dependabot for actions and npm.
6. This proposal does not make the tests meaningful by itself: green CI proves the local suite passes, not that production is secure.

## Rollout

1. Approve this proposal. Recommended: do the skeleton (lint, typecheck, unit tests) right after Phase 1 so Phases 2–4 are guarded.
2. Implement in a branch with no other changes; confirm it passes on the current suite and fails on a deliberately broken local change that is not committed.
3. Owner applies branch protection.
4. Add `security-eval` in Phase 5.
