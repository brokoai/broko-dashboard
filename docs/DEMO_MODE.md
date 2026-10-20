# Demo mode

Demo mode lets Broko show the dashboard **without any backend and without any password**. A visitor opens the login page, picks one of three placeholder accounts (Demo Administrator, Demo Member A, Demo Member B) and is in. It uses **synthetic sample data only** (the `[Demo]` tasks and the placeholder accounts). It cannot read or write any real company data: the demo code has no network, database or Supabase access. The in-app banner says so, and says changes are temporary.

> **Because sign-in is open, anyone who has the URL can use the demo.** That is acceptable only because everything in it is synthetic. Never put real data behind demo mode. (The Team Activity page does show the company leadership record from `src/config/company.ts`; remove or change it there if you don't want that public.)

## When is it on?

| Environment | Needed |
|---|---|
| Local development (`npm run dev`) | `BROKO_DEMO_MODE=true` in `.env.local` |
| Production / Vercel | **All of:** `BROKO_DEMO_MODE=true`, `BROKO_ALLOW_PRODUCTION_DEMO=true`, `BROKO_DEMO_SESSION_SECRET` (≥ 32 chars, random) |
| Any environment with **any** Supabase configuration | **Never.** Demo mode is disabled; the real backend (or "not configured") applies |

"Any Supabase configuration" means any non-empty `SUPABASE_*` or `NEXT_PUBLIC_SUPABASE_*` variable (even a partial set, any case), or the Supabase–Vercel integration's `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`. This is deliberately broad: it fails closed.

If anything is missing in production, demo stays off and the login page says "Sign-in is not configured". Logic: `resolveDemoConfig()` in `src/lib/env.ts` (unit-tested in `tests/demo-env.test.ts`).

`BROKO_DEMO_ACCESS_CODE` is **no longer used**. Earlier versions asked visitors for a shared access code; that was removed. If the variable is still set in Vercel it is ignored and can be deleted.

## Setting it up on Vercel (demo deployment)

Project → Settings → Environment Variables, as normal (non-public) variables for **Production**:

1. `BROKO_DEMO_MODE` = `true`
2. `BROKO_ALLOW_PRODUCTION_DEMO` = `true`
3. `BROKO_DEMO_SESSION_SECRET` = output of `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (keep it secret; mark it a Vercel "Secret")

Redeploy. To switch the demo off, delete either of the first two, or add any Supabase variable, and redeploy.

## Session and cookie security

* **Why a secret is still needed.** Sign-in is open, but the demo session and each visitor's data live in cookies. They are **signed** (HMAC-SHA256) with a key derived from `BROKO_DEMO_SESSION_SECRET`, so a visitor cannot forge or extend a session, swap the account in it, or hand-edit their stored data. Without a secret the key would have to be a constant in the repo, which anyone could use to forge cookies; a per-instance random key would break sessions across serverless instances.
* **Never in the browser.** The secret is a server-side variable only (never `NEXT_PUBLIC_`). It is not sent to the client or logged. A fixed, non-secret development key exists solely for local development; the code refuses to use it in production-like environments.
* **Session cookie:** HttpOnly, SameSite=Lax, `Secure` in production, signed `{account, expiry}`, 8 hours. Every page re-verifies signature and expiry; a forged, unsigned, legacy or expired cookie means signed out.
* There is no per-session revocation: signing out clears the cookie, but a copied cookie stays valid until it expires (8 h) unless you rotate `BROKO_DEMO_SESSION_SECRET` (which signs everyone out).
* Every server action that changes data authenticates first (`requireUser()`), before reading input.
* There is **no rate limiting** on demo sign-in: there is nothing to guess, and a visitor can only ever touch their own browser-local synthetic data. Vercel's own platform limits still apply to invocations.

## Per-visitor demo data

Sample data is regenerated on each request. Only the visitor's changes are stored, in a signed HttpOnly cookie (`broko_demo_state`, 24 h):

* at most 6 changed or new tasks and 8 activity events, titles ≤ 80 and descriptions ≤ 120 characters;
* the payload is capped at 2,800 bytes, so the signed cookie stays well under the 4 KB browser limit;
* strictly validated on every read (unknown fields, wrong types or oversize data are dropped; a bad signature discards everything);
* contains only synthetic data and no secrets;
* never shared with other visitors; "Reset demo" in the banner clears it.

## What is protected

* No API routes exist; the only server entry points are pages and server actions. Unauthenticated requests to any of them are redirected to `/login`; the only unauthenticated action is demo sign-in, which can do nothing except start a signed demo session.
* All responses send `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a strict referrer policy. No CSP is configured yet.

## Limitations

* No authentication in the demo: it demonstrates the product, it does not protect anything. Real sign-in comes with the real backend.
* Demo data does not persist across browsers, devices, or after the 24 h cookie expires.
