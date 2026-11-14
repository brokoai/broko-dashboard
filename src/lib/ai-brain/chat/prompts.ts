/** Client-safe constants (no server imports). */
export const MAX_MESSAGE_CHARS = 500;

import type { ChatIntent } from "./types";

export const SUGGESTED_PROMPTS = [
  "What needs my attention?",
  "Summarize my pending tasks.",
  "What happened today?",
  "Show me overdue follow-ups.",
] as const;

/** Fixed follow-up questions per answer type. Each one is routed by the same deterministic router; none comes from record text. */
export const FOLLOW_UPS: Partial<Record<ChatIntent, readonly string[]>> = {
  attention: ["Show me overdue follow-ups.", "What are the current priorities?"],
  pending_tasks: ["Show me my most critical tasks.", "Show me overdue follow-ups."],
  overdue: ["What are the current priorities?", "What is due this week?"],
  priority: ["Show me overdue follow-ups.", "What is due this week?"],
  upcoming: ["Show me overdue follow-ups.", "What needs my attention?"],
  today: ["What needs my attention?", "Show me overdue follow-ups."],
  summary: ["What needs my attention?", "Show me my most critical tasks."],
  knowledge: ["What does our approved procedure say?", "What needs my attention?"],
  preconstruction: ["Is any information missing or outdated?", "What needs my attention?"],
};
