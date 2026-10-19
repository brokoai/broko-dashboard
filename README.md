# Broko AI Operations — Phase 1

Next.js 16 · TypeScript · Tailwind 4 · Supabase (Auth + Postgres + RLS).

## Run locally (demo mode, no Supabase)

```bash
npm install
echo "BROKO_DEMO_MODE=true" > .env.local
npm run dev
```

Demo mode uses synthetic data and placeholder accounts. It is off in production unless explicitly enabled with an access code, and impossible if any Supabase variable is set. See `docs/DEMO_MODE.md`.

## Backend status

**The production backend has not been chosen** (AWS, Supabase or other). Nothing here is connected to or verified against a real backend.

* The contract the dashboard needs: `docs/BACKEND_INTEGRATION_REQUIREMENTS.md`
* Review of the code and of the Supabase migration: `docs/SECURITY_AND_MIGRATION_REVIEW.md`
* `supabase/migrations/0001_init.sql` is an **unapplied, unverified reference** for a *new* Postgres database. It has known issues (e.g. the "promote first admin" SQL fails as written, see M-2) and must not be applied to an existing database. Proposed fixes are in `supabase/proposed/` (also unapplied).

## Commands

`npm run dev` · `npm run build` · `npm run lint` · `npm run typecheck` · `npm test` (demo-backend and permission unit tests only)

## Notes

- `cacheComponents` is off on purpose: every route depends on the signed-in user.
- Authorization lives in `src/lib/auth.ts` (server) and RLS (database); `src/proxy.ts` is only an optimistic redirect.
- Company leadership (Pankaj Arora, Founder & CEO) is in `src/config/company.ts`. The signed-in user's name/role always come from their profile.
