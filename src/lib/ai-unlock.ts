import { createHash, timingSafeEqual } from "node:crypto";
import { createMemoryRateLimiter, redisLimiterFromEnv, type ModelRateLimiter } from "@/lib/ai-brain/chat";
import { deriveKey, sign, verify } from "@/lib/backend/demo/crypto";
import { looksLikeProduction } from "@/lib/env";

/**
 * Shared demo-code gate for PAID model routing only. The dashboard's own demo login and synthetic data are unchanged.
 *
 * The expected code lives only in the server environment (BROKO_AI_DEMO_CODE). A visitor who enters it receives a signed,
 * time-limited, user-bound cookie; every chat request re-validates that cookie on the server before the model router may be
 * used. Without a valid unlock the chat is simply the deterministic one. The code, the signing key and the throttle store
 * never reach the browser.
 */

export const UNLOCK_COOKIE = "broko_ai_unlock";
export const UNLOCK_TTL_SECONDS = 2 * 60 * 60;
/** A shorter code is treated as "not configured": the gate stays closed rather than guard paid calls with a guessable code. */
export const MIN_DEMO_CODE_LENGTH = 12;
export const MAX_CODE_INPUT = 200;

/** Unlock-attempt ceilings: per client address and across everyone. Every attempt counts, right or wrong. */
export const UNLOCK_PER_CLIENT = { max: 5, windowSec: 15 * 60 };
export const UNLOCK_GLOBAL = { max: 30, windowSec: 60 * 60 };

export const codeConfigured = (expected: string | undefined): expected is string => !!expected && expected.length >= MIN_DEMO_CODE_LENGTH;

/** Constant-time comparison: both sides are hashed to equal length first, so neither length nor content leaks through timing. */
export function codeMatches(given: string, expected: string): boolean {
  if (!codeConfigured(expected) || given.length > MAX_CODE_INPUT) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Signing key for unlock cookies, derived from the demo session secret with its own purpose. null when none may be used. */
export function unlockKey(env: NodeJS.ProcessEnv): Buffer | null {
  try {
    return deriveKey({ secret: env.BROKO_DEMO_SESSION_SECRET?.trim() || undefined, allowDevFallback: !looksLikeProduction(env) }, "ai-unlock");
  } catch {
    return null;
  }
}

export function createUnlockToken(userId: string, key: Buffer, nowMs = Date.now()): string {
  return sign(JSON.stringify({ p: "ai-unlock", u: userId, exp: Math.floor(nowMs / 1000) + UNLOCK_TTL_SECONDS }), key);
}

/** True only for a validly signed, unexpired token issued to THIS user. Anything else (missing, forged, expired, another user's) is false. */
export function isUnlocked(token: string | undefined | null, key: Buffer | null, userId: string, nowMs = Date.now()): boolean {
  if (!key) return false;
  const payload = verify(token, key);
  if (!payload) return false;
  try {
    const { p, u, exp } = JSON.parse(payload) as { p?: unknown; u?: unknown; exp?: unknown };
    return p === "ai-unlock" && u === userId && typeof exp === "number" && exp * 1000 > nowMs && exp * 1000 <= nowMs + UNLOCK_TTL_SECONDS * 1000 + 1000;
  } catch {
    return false;
  }
}

export type UnlockAttempt =
  | { ok: true; token: string }
  | { ok: false; reason: "unavailable" | "throttled" | "invalid" };

export interface UnlockDeps {
  /** BROKO_AI_DEMO_CODE */
  expected: string | undefined;
  key: Buffer | null;
  /** null = no usable attempt store: unlocking is refused. */
  throttle: ModelRateLimiter | null;
  /** Identifies the client for throttling (its address). */
  clientKey: string;
  userId: string;
  now?: () => number;
}

/**
 * The attempt is counted BEFORE the code is compared, so guessing cannot outrun the throttle. A throttle or store failure refuses
 * the unlock (fail closed). The reasons are coarse on purpose: nothing says why a code was wrong.
 */
export async function attemptUnlock(deps: UnlockDeps, given: unknown): Promise<UnlockAttempt> {
  if (!codeConfigured(deps.expected) || !deps.key || !deps.throttle) return { ok: false, reason: "unavailable" };
  let allowed: boolean;
  try { allowed = await deps.throttle.take(deps.clientKey); } catch { return { ok: false, reason: "unavailable" }; }
  if (!allowed) return { ok: false, reason: "throttled" };
  if (typeof given !== "string" || !codeMatches(given.trim(), deps.expected)) return { ok: false, reason: "invalid" };
  return { ok: true, token: createUnlockToken(deps.userId, deps.key, (deps.now ?? Date.now)()) };
}

export const UNLOCK_MESSAGES = {
  unavailable: "AI mode is not available right now.",
  throttled: "Too many attempts. Please try again later.",
  invalid: "That code is not correct.",
} as const;

let memoryThrottle: ModelRateLimiter | undefined;

/**
 * Where unlock attempts are counted. The shared store when one is configured; otherwise a per-process counter OUTSIDE production
 * only (a single local process is a real limit); in production with no store there is none, so unlocking is refused.
 */
export function unlockThrottle(env: NodeJS.ProcessEnv): ModelRateLimiter | null {
  const shared = redisLimiterFromEnv(env, { name: "unlock", perUser: UNLOCK_PER_CLIENT, global: UNLOCK_GLOBAL });
  if (shared) return shared;
  if (env.NODE_ENV === "production") return null;
  return (memoryThrottle ??= createMemoryRateLimiter({ maxCalls: UNLOCK_PER_CLIENT.max, windowMs: UNLOCK_PER_CLIENT.windowSec * 1000 }));
}
