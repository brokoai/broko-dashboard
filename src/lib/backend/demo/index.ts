import "server-only";
import { cookies, headers } from "next/headers";
import { demoConfig, looksLikeProduction } from "@/lib/env";
import { DEMO_COOKIE, DEMO_STATE_COOKIE } from "../constants";
import type { Backend } from "../types";
import { clientKey } from "./client-key";
import {
  codesMatch, createSessionToken, deriveKey, readSessionToken, sign, verify, SESSION_TTL_SECONDS, type KeyPurpose,
} from "./crypto";
import { createRateLimiter } from "./rate-limit";
import { createDemoRepo, DEMO_USERS, type StateStore } from "./repo";

/**
 * Loaded only via dynamic import, and only when resolveDemoConfig() says demo is enabled
 * (never when any Supabase configuration exists). Holds synthetic data only.
 */

const STATE_TTL_SECONDS = 24 * 60 * 60;
// Failed access-code attempts: per client, plus a wider cap across all clients.
// IN-MEMORY, PER SERVER INSTANCE: on serverless hosting this slows guessing but is not a hard
// global limit (see docs/DEMO_MODE.md). The overall cap is also a lockout lever for attackers.
const perClient = createRateLimiter({ max: 5, windowMs: 15 * 60_000 });
const overall = createRateLimiter({ max: 100, windowMs: 15 * 60_000 });

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production", // HTTPS-only cookies on any production deployment
  maxAge,
});

/** Expire a cookie with the SAME attributes it was set with (a Secure cookie can't be overwritten by a non-Secure one). */
async function expire(name: string) {
  (await cookies()).set(name, "", { ...cookieOptions(0), expires: new Date(0) });
}

/** Signing keys: random server-only secret (+ code fingerprint). Throws if production-like and no secret. */
function key(purpose: KeyPurpose): Buffer {
  const { sessionSecret, accessCode } = demoConfig();
  return deriveKey({ secret: sessionSecret, code: accessCode, allowDevFallback: !looksLikeProduction(process.env) }, purpose);
}

function stateStore(): StateStore {
  return {
    async read() {
      return verify((await cookies()).get(DEMO_STATE_COOKIE)?.value, key("state"));
    },
    async write(value) {
      (await cookies()).set(DEMO_STATE_COOKIE, sign(value, key("state")), cookieOptions(STATE_TTL_SECONDS));
    },
  };
}

export const demoBackend: Backend = {
  kind: "demo",
  async getCurrentUser() {
    const id = readSessionToken((await cookies()).get(DEMO_COOKIE)?.value, key("session"));
    return DEMO_USERS.find((u) => u.id === id) ?? null;
  },
  async signInWithPassword() {
    return { error: "Demo mode uses the placeholder accounts on the sign-in page." };
  },
  async signOut() {
    await expire(DEMO_COOKIE);
  },
  async repoFor(user) {
    return createDemoRepo(user, stateStore());
  },
  demo: {
    accounts: DEMO_USERS,
    get codeRequired() { return Boolean(demoConfig().accessCode); },
    async signInAs(id, code) {
      const { enabled, accessCode } = demoConfig();
      if (!enabled) return { error: "Demo mode is not available." };
      if (accessCode) {
        const h = await headers();
        const ip = clientKey((name) => h.get(name), process.env);
        const a = perClient.check(ip);
        const b = overall.check("all");
        if (!a.allowed || !b.allowed) {
          return { error: `Too many attempts. Try again in ${Math.ceil(Math.max(a.retryAfterSec, b.retryAfterSec) / 60)} minute(s).` };
        }
        if (!codesMatch(code, accessCode)) {
          perClient.fail(ip);
          overall.fail("all");
          return { error: "Invalid access code." };
        }
        perClient.clear(ip);
      }
      if (!DEMO_USERS.some((u) => u.id === id)) return { error: "Choose a demo account." };
      (await cookies()).set(DEMO_COOKIE, createSessionToken(id, key("session")), cookieOptions(SESSION_TTL_SECONDS));
      return {};
    },
    async reset() {
      await expire(DEMO_STATE_COOKIE);
    },
  },
};
