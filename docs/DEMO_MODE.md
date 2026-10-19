# Demo mode

Demo mode lets Broko show the dashboard **without any backend**. It uses **synthetic sample data only** (the `[Demo]` tasks and three placeholder accounts). It cannot read or write any real company data: the demo code has no network, database or Supabase access. The in-app banner says so, and says changes are temporary.

## When is it on?

| Environment | Needed |
|---|---|
| Local development (`npm run dev`) | `BROKO_DEMO_MODE=true` in `.env.local` (no code, no secret) |
| Production / Vercel | **All four:** `BROKO_DEMO_MODE=true`, `BROKO_ALLOW_PRODUCTION_DEMO=true`, `BROKO_DEMO_ACCESS_CODE` (≥ 12 chars), `BROKO_DEMO_SESSION_SECRET` (≥ 32 chars, random) |
| Any environment with **any** Supabase configuration | **Never.** Demo mode is disabled; the real backend (or "not configured") applies |

"Any Supabase configuration" means any non-empty `SUPABASE_*` or `NEXT_PUBLIC_SUPABASE_*` variable (even a partial set, any case), or the Supabase–Vercel integration's `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`. This is deliberately broad: it fails closed.

If anything is missing in production, demo stays off and the login page says "Sign-in is not configured". Logic: `resolveDemoConfig()` in `src/lib/env.ts` (unit-tested in `tests/demo-env.test.ts`).

## Setting it up on Vercel (demo deployment)

Project → Settings → Environment Variables, as normal (non-public) variables, for the environment you deploy:

1. `BROKO_DEMO_MODE` = `true`
2. `BROKO_ALLOW_PRODUCTION_DEMO` = `true`
3. `BROKO_DEMO_ACCESS_CODE` = a long random code (≥ 12 chars); share it with the people you want to give access
4. `BROKO_DEMO_SESSION_SECRET` = output of `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (different from the code; never shared)

Redeploy. To switch the demo off, delete either of the first two, or add any Supabase variable, and redeploy.

## Access code and session security

* The code is a server-side environment variable only: never in the repo, never `NEXT_PUBLIC_`, never sent to the browser. It is checked on the server (SHA-256 of both values compared in constant time).
* **Cookie signing keys come from the separate random `BROKO_DEMO_SESSION_SECRET`, not from the code.** A human-chosen code is never the only key material, so a captured cookie can't be used to brute-force it offline. The code's fingerprint is mixed into the key only so that changing the code also signs everyone out.
* A fixed development key exists solely for local development; the code refuses to use it in production-like environments.
* On success the server sets an **HttpOnly, SameSite=Lax, `Secure` (production)** cookie with a signed `{account, expiry}` (HMAC-SHA256, 8 hours). Every page re-verifies signature and expiry; a forged, unsigned, legacy or expired cookie means signed out.
* There is no per-session revocation: signing out clears the cookie, but a stolen cookie stays valid until it expires (8 h) unless you rotate `BROKO_DEMO_SESSION_SECRET` or the access code (which invalidates all sessions).
* Every server action that changes data authenticates first (`requireUser()`), before reading input.

## Rate limiting: what it does and does not do

Failed access-code attempts are limited to **5 per 15 minutes per client**, and **100 per 15 minutes overall**. Know the limits:

* **It is in-memory and per server instance.** Vercel runs many short-lived, parallel instances with no shared memory, so counters reset on cold starts and each instance counts separately. An attacker can get more attempts than the nominal limit. It slows guessing; it is **not** a guarantee. Treat it as a speed bump.
* **Client identification.** Forwarded-IP headers are client-controlled unless a trusted proxy sets them, so they are used only where the setter is known: on Vercel (`x-vercel-forwarded-for`/`x-real-ip`, set by the platform; we have not verified this on a live Vercel deployment) or behind your own proxy when `BROKO_TRUST_PROXY=true` (rightmost `x-forwarded-for`). Otherwise all requests share one bucket, so spoofing headers gains nothing. IPs are never logged.
* **The overall cap can be abused** to lock everyone out of the demo for 15 minutes (a nuisance, not a data risk).
* **The real protection is the code's strength.** Use a long random code (≥ 12 chars minimum; 20+ recommended), and rotate it when sharing widens.
* **Stronger options if needed:** a Vercel Firewall rate-limit rule on `POST /login` (if your plan includes it), or a shared store (e.g. Upstash/Vercel KV) for the counters.
* There is a small race: concurrent attempts can slip past a check before the failure is recorded.

## Per-visitor demo data

Sample data is regenerated on each request. Only the visitor's changes are stored, in a signed HttpOnly cookie (`broko_demo_state`, 24 h):

* at most 6 changed or new tasks and 8 activity events, titles ≤ 80 and descriptions ≤ 120 characters;
* the payload is capped at 2,800 bytes, so the signed cookie stays well under the 4 KB browser limit;
* strictly validated on every read (unknown fields, wrong types or oversize data are dropped; a bad signature discards everything);
* contains only synthetic data and no secrets;
* never shared with other visitors; "Reset demo" in the banner clears it.

## What is protected

* No API routes exist; the only server entry points are pages and server actions. Unauthenticated requests to any of them are redirected to `/login`.
* The demo sign-in action is the only unauthenticated write path, and it needs the access code (production).
* All responses send `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a strict referrer policy. No CSP is configured yet.

## Limitations

* The access code is a shared secret, not per-user authentication; it is for demonstrations, not for protecting real data. Never put real data behind demo mode.
* Rate limiting is best-effort (see above).
* Demo data does not persist across browsers, devices, or after the 24 h cookie expires.
