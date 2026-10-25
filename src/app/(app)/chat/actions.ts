"use server";

import { cookies, headers } from "next/headers";
import { getRepo, requireUser } from "@/lib/auth";
import { attemptUnlock, codeConfigured, isUnlocked, MAX_CODE_INPUT, UNLOCK_COOKIE, UNLOCK_MESSAGES, UNLOCK_TTL_SECONDS, unlockKey, unlockThrottle } from "@/lib/ai-unlock";
import { getBackend } from "@/lib/backend";
import { chatRouter } from "@/lib/chat-model";
import { handleChat, type ChatActionResult } from "@/lib/chat-service";

/** True when the signed-in user holds a valid, unexpired AI unlock. Re-checked on every request; nothing is cached or trusted from the browser. */
async function aiUnlocked(userId: string): Promise<boolean> {
  const token = (await cookies()).get(UNLOCK_COOKIE)?.value;
  return isUnlocked(token, unlockKey(process.env), userId);
}

/**
 * The only entry from the floating chat to the AI Brain. Authenticates first; the user, role and data mode come from the
 * server session and backend, never from the request. The browser sends one question and nothing else.
 * The model interpreter (paid) is handed over ONLY to an unlocked user; everyone else gets the deterministic chat.
 */
export async function askBroko(message: string): Promise<ChatActionResult> {
  const user = await requireUser();
  const backend = await getBackend();
  const router = (await aiUnlocked(user.id)) ? chatRouter() : null;
  return handleChat({ user, backendKind: backend.kind, repoFor: getRepo, router: router ?? undefined }, message);
}

/** What the chat should offer: whether AI mode exists at all, and whether this user has unlocked it. Reveals no configuration. */
export async function aiChatStatus(): Promise<{ available: boolean; unlocked: boolean }> {
  const user = await requireUser();
  const available = chatRouter() !== null && codeConfigured(process.env.BROKO_AI_DEMO_CODE);
  return { available, unlocked: available && (await aiUnlocked(user.id)) };
}

/** Checks the shared demo code on the server and, if right, sets a signed, user-bound, time-limited cookie. */
export async function unlockAiChat(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (typeof code !== "string" || code.length > MAX_CODE_INPUT || chatRouter() === null) return { ok: false, error: UNLOCK_MESSAGES.unavailable };
  const forwarded = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64);
  const result = await attemptUnlock(
    { expected: process.env.BROKO_AI_DEMO_CODE, key: unlockKey(process.env), throttle: unlockThrottle(process.env), clientKey: `ip:${forwarded || "unknown"}`, userId: user.id },
    code,
  );
  if (!result.ok) return { ok: false, error: UNLOCK_MESSAGES[result.reason] };
  (await cookies()).set(UNLOCK_COOKIE, result.token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: UNLOCK_TTL_SECONDS });
  return { ok: true };
}
