import type { ChatReply, ChatTurn } from "@/lib/ai-brain/chat/types";
import { MAX_MESSAGE_CHARS } from "@/lib/ai-brain/chat/prompts";

/**
 * Display state of the floating chat. Held in the browser tab's memory only: nothing here is saved or sent back to the server,
 * and it is gone on reload. (See docs/ai-brain/CHAT.md.)
 */
export interface ChatState {
  open: boolean;
  turns: ChatTurn[];
  pending: boolean;
  nextId: number;
  /** Bumped by "clear" so an answer to a question asked before the clear is dropped, not shown. */
  epoch: number;
}

export type ChatAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "send"; text: string }
  | { type: "reply"; reply: ChatReply; epoch: number }
  | { type: "error"; message: string; epoch: number }
  | { type: "retry" }
  | { type: "clear" };

export const MAX_TURNS = 40;
export const initialChatState: ChatState = { open: false, turns: [], pending: false, nextId: 1, epoch: 0 };

type NewTurn = ChatTurn extends infer T ? (T extends ChatTurn ? Omit<T, "id"> : never) : never;

const push = (s: ChatState, turn: NewTurn, extra: Partial<ChatState>): ChatState => {
  const turns: ChatTurn[] = [...s.turns, { ...turn, id: s.nextId } as ChatTurn];
  return { ...s, ...extra, turns: turns.slice(-MAX_TURNS), nextId: s.nextId + 1 };
};

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "open": return s.open ? s : { ...s, open: true };
    case "close": return s.open ? { ...s, open: false } : s;
    case "send": {
      const text = a.text.trim();
      if (s.pending || !text || text.length > MAX_MESSAGE_CHARS) return s;
      return push(s, { role: "user", content: text }, { pending: true });
    }
    case "reply": return s.pending && a.epoch === s.epoch ? push(s, { role: "assistant", reply: a.reply }, { pending: false }) : s;
    case "error": return s.pending && a.epoch === s.epoch ? push(s, { role: "error", content: a.message }, { pending: false }) : s;
    case "retry": {
      // Only a trailing error that follows a user question can be retried: drop the error and wait for a new answer.
      const last = s.turns[s.turns.length - 1], prev = s.turns[s.turns.length - 2];
      if (s.pending || last?.role !== "error" || prev?.role !== "user") return s;
      return { ...s, turns: s.turns.slice(0, -1), pending: true };
    }
    case "clear": return { ...s, turns: [], pending: false, epoch: s.epoch + 1 };
  }
}

/** Internal links only. Anything else (absolute, protocol-relative, javascript:) is dropped. */
export function safeHref(href: string | undefined): string | undefined {
  return href && /^\/(?!\/)[A-Za-z0-9/_-]*(#p\d{1,4})?$/.test(href) ? href : undefined;
}

/** The question to re-send for a "retry" (the user turn before a trailing error), or null. */
export function retryText(s: ChatState): string | null {
  const last = s.turns[s.turns.length - 1], prev = s.turns[s.turns.length - 2];
  return !s.pending && last?.role === "error" && prev?.role === "user" ? prev.content : null;
}
