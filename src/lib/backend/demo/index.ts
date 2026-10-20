import "server-only";
import { cookies } from "next/headers";
import { demoConfig, looksLikeProduction } from "@/lib/env";
import { DEMO_COOKIE, DEMO_STATE_COOKIE } from "../constants";
import type { Backend } from "../types";
import { createSessionToken, deriveKey, readSessionToken, sign, verify, SESSION_TTL_SECONDS, type KeyPurpose } from "./crypto";
import { createDemoRepo, DEMO_USERS, type StateStore } from "./repo";

/**
 * Loaded only via dynamic import, and only when resolveDemoConfig() says demo is enabled
 * (never when any Supabase configuration exists). Holds synthetic data only. Sign-in is open:
 * a visitor picks a placeholder account; there is no password or access code.
 */

const STATE_TTL_SECONDS = 24 * 60 * 60;

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

/** Signing keys come from the random server-only secret. Throws if production-like and none is set. */
function key(purpose: KeyPurpose): Buffer {
  return deriveKey({ secret: demoConfig().sessionSecret, allowDevFallback: !looksLikeProduction(process.env) }, purpose);
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
    async signInAs(id) {
      if (!demoConfig().enabled) return { error: "Demo mode is not available." };
      if (!DEMO_USERS.some((u) => u.id === id)) return { error: "Choose a demo account." };
      (await cookies()).set(DEMO_COOKIE, createSessionToken(id, key("session")), cookieOptions(SESSION_TTL_SECONDS));
      return {};
    },
    async reset() {
      await expire(DEMO_STATE_COOKIE);
    },
  },
};
