import { ChatInputError, askBrain, type ChatReply } from "@/lib/ai-brain/chat";
import type { Backend, Repo } from "@/lib/backend/types";
import type { Profile } from "@/lib/types";

export type ChatActionResult = { ok: true; reply: ChatReply } | { ok: false; error: string };

export interface ChatServiceDeps {
  /** Already validated server-side. Never taken from the request body. */
  user: Profile | null;
  backendKind: Backend["kind"];
  repoFor: (user: Profile) => Promise<Repo>;
  now?: () => Date;
  log?: (e: unknown) => void;
}

/**
 * Orchestration behind the chat server action, free of Next.js so it can be tested directly.
 * Mode is derived from the configured backend: a Supabase session is "live" and is NEVER answered from demo data.
 */
export async function handleChat(deps: ChatServiceDeps, message: unknown): Promise<ChatActionResult> {
  if (!deps.user) return { ok: false, error: "Please sign in again." };
  if (typeof message !== "string") return { ok: false, error: "Invalid request." };
  if (deps.backendKind === "unconfigured") return { ok: false, error: "The assistant is not available: no backend is configured." };
  const mode = deps.backendKind === "demo" ? "demo" : "live";
  try {
    const repo = await deps.repoFor(deps.user);
    const reply = await askBrain({ user: deps.user, mode, repo, now: (deps.now ?? (() => new Date()))() }, message);
    return { ok: true, reply };
  } catch (e) {
    if (e instanceof ChatInputError) return { ok: false, error: e.message };
    (deps.log ?? console.error)("[chat]", e);
    return { ok: false, error: "The assistant could not answer right now. Please try again." };
  }
}
