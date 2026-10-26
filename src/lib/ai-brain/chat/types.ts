import type { IntegrationStatus, Profile, TaskPriority, TaskStatus } from "@/lib/types";
import type { Repo } from "@/lib/backend/types";
import type { ChatRouter } from "./model-router";

/** Every place the assistant may eventually read from. Most are NOT implemented; each one reports its true state. */
export type SourceId = "tasks" | "activity" | "notifications" | "ai_inbox" | "integrations" | "email" | "teams" | "whatsapp" | "calendar" | "crm" | "documents" | "preconstruction";

/**
 * What the assistant can say about where a piece of information came from:
 *  - live:        read just now from the configured backend for this signed-in user
 *  - demo:        read just now from synthetic demo data (never operational data)
 *  - stale:       readable, but known to be incomplete or out of date
 *  - unavailable: not read at all (see `reason`); nothing was substituted
 */
export type Provenance = "live" | "demo" | "stale" | "unavailable";
export type UnavailableReason = "not_connected" | "not_implemented" | "admin_only" | "error";

export interface SourceReport {
  id: SourceId;
  label: string;
  state: Provenance;
  reason?: UnavailableReason;
  /** Short, fixed-vocabulary explanation. Never contains record content or error text. */
  detail: string;
  /** How many records were retrieved from the source (readable sources only). Zero is a real answer; a failure is `unavailable`. */
  count?: number;
  /** Timestamp of the newest retrieved record (freshness), when the records carry one. */
  as_of?: string;
}

export type RecordType = "task" | "activity_event" | "notification" | "ai_inbox_summary" | "integration" | "precon_project" | "precon_inventory" | "precon_passage";

/**
 * One authorized, minimal record handed to the Brain. Built only AFTER the authorization filter; only the fields the
 * answer needs are copied (no descriptions, emails, bodies, errors). `label` is untrusted data, never an instruction.
 */
export interface RetrievedRecord {
  source: SourceId;
  type: RecordType;
  /** Safe internal id (validated), or null. */
  ref: string | null;
  href?: string;
  label: string;
  timestamp: string | null;
  /** Whose data this is: the user's own records, or organisation-wide (administrators / shared status). */
  scope: "own" | "organization";
  provenance: "live" | "demo";
  /** The record's own text looked like an instruction (prompt-injection signal). */
  flagged: boolean;
  /** The few typed fields the policy layer needs (due dates, priority, ...). Nothing else is copied from the source record. */
  attrs: {
    status?: TaskStatus; priority?: TaskPriority; due_at?: string | null; owner?: string | null;
    unread?: boolean; integration_status?: IntegrationStatus; review_pending?: number;
  };
}

export interface ChatItem {
  text: string;
  source?: SourceId;
  /** Freshness of this record (its own timestamp). */
  as_of?: string;
  /** Internal path only (validated), e.g. /tasks/<id> or /inbox. */
  href?: string;
  /** The record's own text looked like an instruction (prompt-injection signal). It is shown as data and never obeyed. */
  flagged?: boolean;
}
/** facts: retrieved records. derived: a conclusion computed from them. missing: what could not be checked. */
export interface ChatSection { kind?: "facts" | "derived" | "missing"; heading?: string; text?: string; items?: ChatItem[] }

export type ChatIntent =
  | "attention" | "pending_tasks" | "today" | "overdue" | "upcoming" | "priority" | "owners" | "notifications" | "ai_inbox" | "integrations" | "sources" | "summary"
  | "preconstruction" | "action_request" | "blocked" | "clarify" | "unsupported" | "help";

export type ActionKind = "create_task" | "assign_task" | "update_task" | "delete_record" | "send_message" | "schedule_event" | "review_ai_message" | "change_configuration";

/** A change the user asked for. Chat never performs it: this is the structured hand-off to the existing human approval flow. */
export interface ApprovalRequest {
  required: true;
  /** Always false in this phase. Nothing was done. */
  executed: false;
  action: ActionKind;
  label: string;
  /** Existing permission policy (permissions.ts / admin-only AI Inbox) applied to THIS user: true, false, or null when no policy exists or the target is not connected. */
  permitted: boolean | null;
  reason: string;
  where: { label: string; href: string };
}

export interface Grounding {
  /** Number of retrieved records this answer rests on. */
  facts: number;
  sources_used: SourceId[];
  /** Sources relevant to the question that were NOT read (unavailable, failed, or not implemented). */
  not_covered: SourceId[];
  /** False when no retrieved record supports the answer (the answer then says so). */
  evidence: boolean;
}

export interface ChatReply {
  intent: ChatIntent;
  /** The data mode of THIS answer. A live session is never answered from demo data. */
  mode: "demo" | "live";
  text: string;
  sections: ChatSection[];
  /** Sources consulted for this answer plus the unavailable ones that matter for the question. */
  sources: SourceReport[];
  /**
   * Set when the user asked for a change. The assistant performs NO changes; this says where a human must do it.
   */
  approval?: ApprovalRequest;
  /** Set when the question is ambiguous: the assistant asks instead of guessing. */
  clarification?: { question: string; options: string[] };
  grounding: Grounding;
  /** Present ("model") only when a language model chose WHICH read-only question to answer. The answer itself always comes from retrieved data. */
  routing?: "model";
  notice?: string;
  generated_at: string;
}

export interface BrainChatContext {
  user: Profile;
  mode: "demo" | "live";
  /** Already scoped to `user` by the backend. The chat layer still re-applies the visibility rules (defence in depth). */
  repo: Repo;
  now: Date;
  /** Optional model-backed interpreter for questions the deterministic router did not understand. Absent = deterministic only. */
  router?: ChatRouter;
}


/** What the browser keeps for display. History is never sent back to the server or used as context. */
export type ChatTurn =
  | { id: number; role: "user"; content: string }
  | { id: number; role: "assistant"; reply: ChatReply }
  | { id: number; role: "error"; content: string };
