import type { ChatIntent, ChatReply, SourceId } from "./types";

/**
 * Metadata-only audit of a chat question. By construction there is no field that can hold the message, a prompt, a model output,
 * the answer text, record content or an error message: every value is a fixed vocabulary, a number, a boolean or an id.
 * The database enforces the same shape (supabase/proposed/0008_chat_audit.proposed.sql).
 */
export type ChatAuditOutcome = "answered" | "unsupported" | "clarification" | "approval_required" | "blocked" | "rejected" | "error";

export interface ChatAuditEntry {
  /** Null when the call failed before the Brain chose an intent. */
  intent: ChatIntent | null;
  outcome: ChatAuditOutcome;
  /** The project the user scoped the question to, only when it has the shape of an id. */
  project_id: string | null;
  source_ids: SourceId[];
  record_count: number;
  has_evidence: boolean;
  /** True only when the optional model router chose the intent. */
  used_model: boolean;
  latency_ms: number;
}

/** Absent on every backend that has nowhere to keep it (the demo): nothing is recorded there. */
export interface ChatAuditWriter {
  record(entry: ChatAuditEntry): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clamp = (n: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0);
const projectIdOf = (projectId: unknown) => (typeof projectId === "string" && UUID.test(projectId) ? projectId.toLowerCase() : null);

function outcomeOf(reply: ChatReply): ChatAuditOutcome {
  if (reply.approval) return "approval_required";
  if (reply.intent === "blocked") return "blocked";
  if (reply.intent === "unsupported") return "unsupported";
  if (reply.intent === "clarify") return "clarification";
  return "answered";
}

export function auditEntryForReply(reply: ChatReply, projectId: unknown, latencyMs: number): ChatAuditEntry {
  return {
    intent: reply.intent,
    outcome: outcomeOf(reply),
    project_id: projectIdOf(projectId),
    source_ids: [...new Set(reply.grounding.sources_used)].slice(0, 12),
    record_count: clamp(reply.grounding.facts, 100000),
    has_evidence: reply.grounding.evidence === true,
    used_model: reply.routing === "model",
    latency_ms: clamp(latencyMs, 600000),
  };
}

export function auditEntryForFailure(outcome: "rejected" | "error", projectId: unknown, latencyMs: number): ChatAuditEntry {
  return { intent: null, outcome, project_id: projectIdOf(projectId), source_ids: [], record_count: 0, has_evidence: false, used_model: false, latency_ms: clamp(latencyMs, 600000) };
}
