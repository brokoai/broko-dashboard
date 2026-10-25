"use server";

import { getRepo, requireUser } from "@/lib/auth";
import { getBackend } from "@/lib/backend";
import { handleChat, type ChatActionResult } from "@/lib/chat-service";

/**
 * The only entry from the floating chat to the AI Brain. Authenticates first; the user, role and data mode come from the
 * server session and backend, never from the request. The browser sends one question and nothing else.
 */
export async function askBroko(message: string): Promise<ChatActionResult> {
  const user = await requireUser();
  const backend = await getBackend();
  return handleChat({ user, backendKind: backend.kind, repoFor: getRepo }, message);
}
