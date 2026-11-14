import { ChatInputError, askBrain, type ChatReply, type ChatRouter, type Synthesizer } from "@/lib/ai-brain/chat";
import { parseFocus, parseHistory } from "@/lib/ai-brain/chat/focus";
import type { Interpreter } from "@/lib/ai-brain/chat/interpreter";
import type { ToolAgent } from "@/lib/ai-brain/chat/tool-agent";
import type { MeetingCache } from "@/lib/ai-brain/chat/meeting-cache";
import { auditEntryForFailure, auditEntryForReply, type ChatAuditEntry } from "@/lib/ai-brain/chat/audit";
import type { Backend, Repo } from "@/lib/backend/types";
import type { Profile } from "@/lib/types";

export type ChatActionResult = { ok: true; reply: ChatReply } | { ok: false; error: string };

export interface ChatServiceDeps {
  /** Already validated server-side. Never taken from the request body. */
  user: Profile | null;
  backendKind: Backend["kind"];
  repoFor: (user: Profile) => Promise<Repo>;
  now?: () => Date;
  /** Optional model-backed interpreter, shared with the rest of the Brain. Absent = deterministic routing only. */
  router?: ChatRouter;
  /** Optional analysis model (meetings). Absent = deterministic replies only. */
  synthesizer?: Synthesizer;
  /** Optional language-understanding step (see chat/interpreter.ts). Absent = the message is used as typed. */
  interpreter?: Interpreter;
  /** Optional Claude tool-use path (see chat/tool-agent.ts). Absent = the ordinary Brain path only. */
  toolAgent?: ToolAgent;
  /** The time zone dates and times in questions are read in: the asker's own, else the organisation default. */
  timeZone?: string;
  /** Short-lived memory of meetings just analysed, so follow-ups do not repeat the work. Absent = none. */
  meetingCache?: MeetingCache;
  log?: (e: unknown) => void;
  /** Longest a chat reply may wait for the audit write. Defaults to 3 s. */
  auditTimeoutMs?: number;
}

/**
 * Orchestration behind the chat server action, free of Next.js so it can be tested directly.
 * Mode is derived from the configured backend: a Supabase session is "live" and is NEVER answered from demo data.
 */
export async function handleChat(deps: ChatServiceDeps, message: unknown, projectId?: unknown, focus?: unknown, history?: unknown): Promise<ChatActionResult> {
  if (!deps.user) return { ok: false, error: "Please sign in again." };
  if (typeof message !== "string") return { ok: false, error: "Invalid request." };
  if (deps.backendKind === "unconfigured") return { ok: false, error: "The assistant is not available: no backend is configured." };
  const mode = deps.backendKind === "demo" ? "demo" : "live";
  const clock = deps.now ?? (() => new Date());
  const started = clock().getTime();
  const scope = typeof projectId === "string" ? projectId.slice(0, 64) : undefined;
  let repo: Repo | undefined;
  try {
    repo = await deps.repoFor(deps.user);
    const reply = await askBrain({ user: deps.user, mode, repo, now: clock(), router: deps.router, synthesizer: deps.synthesizer, timeZone: deps.timeZone, focus: parseFocus(focus), history: parseHistory(history), interpreter: deps.interpreter, toolAgent: deps.toolAgent, meetingCache: deps.meetingCache,
      // Persistent organizational memory for THIS user, from their own repository (their session; RLS and the administrator-only functions apply). Absent in the demo.
      ...(repo.orgMemory ? { orgMemory: repo.orgMemory.reader } : {}) }, message, {
      // Optional project context from "Ask about this project". Only a string id is accepted; the Brain validates and authorizes it.
      projectId: scope,
    });
    await audit(deps, repo, auditEntryForReply(reply, scope, clock().getTime() - started));
    return { ok: true, reply };
  } catch (e) {
    if (e instanceof ChatInputError) {
      await audit(deps, repo, auditEntryForFailure("rejected", scope, clock().getTime() - started));
      return { ok: false, error: e.message };
    }
    (deps.log ?? console.error)("[chat]", e);
    await audit(deps, repo, auditEntryForFailure("error", scope, clock().getTime() - started));
    return { ok: false, error: "The assistant could not answer right now. Please try again." };
  }
}

const AUDIT_TIMEOUT_MS = 3000;

/**
 * Metadata only, and best effort: a failure to record is logged (without the entry's context) and never changes the answer.
 * A write that hangs is abandoned after a timeout, so the audit can delay a reply by a few seconds at most and never hold it.
 */
async function audit(deps: ChatServiceDeps, repo: Repo | undefined, entry: ChatAuditEntry): Promise<void> {
  if (!repo?.chatAudit) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("audit write timed out")), deps.auditTimeoutMs ?? AUDIT_TIMEOUT_MS); });
    await Promise.race([repo.chatAudit.record(entry), timeout]);
  } catch (e) {
    (deps.log ?? console.error)("[chat] audit failed", e);
  } finally {
    clearTimeout(timer);
  }
}
