import { createHmac, timingSafeEqual } from "node:crypto";

// Demo backend only. Nothing secret is hardcoded.
//
// Cookie-signing keys come from a random server-only secret (BROKO_DEMO_SESSION_SECRET). Signing
// keeps demo sessions and per-visitor data tamper-evident (a visitor cannot forge a longer
// session or alter the stored data); the data itself is synthetic and the sign-in is open.
//
// A fixed, NON-SECRET development key exists solely for local development without any secret.
// deriveKey() refuses to use it when `allowDevFallback` is false (production-like environments).
const DEV_ONLY_KEY_MATERIAL = "broko-local-development-demo-only";

export type KeyPurpose = "session" | "state";

export interface KeyMaterial {
  /** BROKO_DEMO_SESSION_SECRET */
  secret?: string;
  /** True only outside production-like environments. */
  allowDevFallback: boolean;
}

export function deriveKey({ secret, allowDevFallback }: KeyMaterial, purpose: KeyPurpose): Buffer {
  if (!secret && !allowDevFallback) throw new Error("Demo session secret is required in this environment.");
  return createHmac("sha256", secret || DEV_ONLY_KEY_MATERIAL).update(`broko-demo:${purpose}:v3`).digest();
}

/** token = base64url(payload) + "." + base64url(HMAC-SHA256(key, base64url(payload))) */
export function sign(payload: string, key: Buffer): string {
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** Returns the payload if the signature is valid, otherwise null. Constant-time compare. */
export function verify(token: string | undefined | null, key: Buffer): string | null {
  if (!token || token.length > 8192) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", key).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export function createSessionToken(userId: string, key: Buffer, nowMs = Date.now()): string {
  return sign(JSON.stringify({ u: userId, exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS }), key);
}

/** Returns the user id for a valid, unexpired session token, otherwise null. */
export function readSessionToken(token: string | undefined | null, key: Buffer, nowMs = Date.now()): string | null {
  const payload = verify(token, key);
  if (!payload) return null;
  try {
    const { u, exp } = JSON.parse(payload) as { u?: unknown; exp?: unknown };
    if (typeof u !== "string" || typeof exp !== "number" || exp * 1000 < nowMs) return null;
    return u;
  } catch {
    return null;
  }
}
