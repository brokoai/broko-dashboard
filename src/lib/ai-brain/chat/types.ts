import type { IntegrationStatus, Profile, TaskPriority, TaskStatus } from "@/lib/types";
import type { Repo } from "@/lib/backend/types";
import type { ChatRouter } from "./model-router";
import type { Synthesizer } from "./synthesizer";
import type { ActionProposal } from "../assistant/proposals";
import type { ToolRegistry } from "../assistant/tools";
import type { Connectors } from "../assistant/connectors";
import type { IntegrationRuntime } from "../integrations/types";
import type { MeetingCache } from "./meeting-cache";
import type { Interpreter } from "./interpreter";
import type { ToolAgent } from "./tool-agent";
import type { OrgMemoryReader } from "../org-memory/types";

/** Every place the assistant may eventually read from. Most are NOT implemented; each one reports its true state. */
export const SOURCE_IDS = [
  "tasks", "activity", "notifications", "ai_inbox", "integrations", "email", "teams", "whatsapp", "calendar", "crm", "documents", "preconstruction", "knowledge",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

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
  /** When this answer read the source (server clock). Set on every source of every reply. */
  retrieved_at?: string;
}

export type RecordType = "task" | "activity_event" | "notification" | "ai_inbox_summary" | "integration" | "precon_project" | "precon_inventory" | "precon_passage" | "knowledge_item" | "external_page";

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
    /** Approved organizational knowledge only (see src/lib/knowledge): the few fields an answer needs to cite it honestly. */
    knowledge?: {
      kind: string; topic: string | null; excerpt: string; project_id: string | null;
      reviewed_at: string | null; reviewer: string | null; source_note: string | null; stale: boolean; expires_at: string | null;
    };
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
  /** Link to the original record in its own system (validated to an https Notion address before it is rendered). */
  external_url?: string;
  /** Source segment ids this item rests on, for example ["S3","S5"]. */
  cite?: string[];
}
/** facts: retrieved records. derived: a conclusion computed from them. missing: what could not be checked. */
export interface ChatSection { kind?: "facts" | "derived" | "recommendation" | "missing"; heading?: string; text?: string; items?: ChatItem[] }

export const CHAT_INTENTS = [
  "attention", "pending_tasks", "today", "overdue", "upcoming", "priority", "owners", "notifications", "ai_inbox", "integrations", "sources", "summary",
  "preconstruction", "knowledge", "action_request", "blocked", "clarify", "unsupported", "help",
] as const;
export type ChatIntent = (typeof CHAT_INTENTS)[number];

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

/**
 * What the current conversation is about, so a follow-up ("who owns that?", "the previous meeting") can be understood. The server puts it on a
 * reply and the browser sends it back with the next question. It is a hint, never an authority: the server validates its shape and
 * re-reads the meeting through the normal authorized path, so a forged focus can reach nothing the user could not already ask for.
 * It lives only in the open chat tab and is not stored anywhere.
 */
export interface ChatFocus {
  kind: "meeting";
  /** The meeting page id. */
  id: string;
  title: string;
  /** When the meeting happened (ISO instant, or YYYY-MM-DD when only a date is recorded). */
  starts_at?: string;
  /** What the last answer about it was, so "what about the previous one?" keeps the same kind of answer. */
  output: "summary" | "decisions" | "action_items" | "content" | "all";
  /** A few words the meeting was about, used as search terms for "was this discussed before?". */
  topics: string[];
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
  /** Phase 1: a prepared, NOT executed, NOT stored proposal for the change the user asked for. Display only. */
  proposal?: ActionProposal;
  /** Fixed follow-up questions that this assistant can answer next. Never derived from record text. */
  follow_ups?: string[];
  /** Set when the question is ambiguous: the assistant asks instead of guessing. */
  clarification?: { question: string; options: string[] };
  grounding: Grounding;
  /** Present ("model") only when a language model chose WHICH read-only question to answer. The answer itself always comes from retrieved data. */
  routing?: "model";
  /**
   * How THIS answer was produced. "rules": deterministic code only. "model_routed": a model picked the question. "model_synthesised": a model wrote
   * the analysis from the source shown, and the Brain validated it against that source. Absent on older replies, which mean "rules".
   */
  generation?: "rules" | "model_routed" | "model_synthesised";
  notice?: string;
  /** Where the data in THIS answer came from: demo (synthetic), live (real, authorized), or mixed. Never "demo" for a real Notion answer. */
  data?: "demo" | "live" | "mixed";
  /** The conversation topic after this answer (see ChatFocus). */
  focus?: ChatFocus;
  /** A conversational answer: technical footers (record counts) are not shown. */
  quiet?: boolean;
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
  /** Optional model that analyses content the Brain already retrieved and authorized (meetings). Absent = deterministic replies only. */
  synthesizer?: Synthesizer;
  /** The organisation's default time zone for dates in questions ("on 23 October at 1 PM"). Absent = UTC, and the answer says so. */
  timeZone?: string;
  /** Optional language-understanding step: restates what the user meant (typos, Hinglish, follow-ups) before the Brain acts. Absent = the message is used as typed. */
  interpreter?: Interpreter;
  /** Optional Claude tool-use path through the Tool Registry (flag BROKO_AI_TOOLS). Absent = the ordinary Brain path only. */
  toolAgent?: ToolAgent;
  /** The user's own last few questions in this open chat, oldest first. Only a hint for the interpreter; never an authority. */
  history?: string[];
  /** Optional short-lived memory of meetings just read and analysed, so follow-ups do not use the analysis budget again. Absent = none. */
  meetingCache?: MeetingCache;
  /** What the conversation so far is about, already validated by the server (see ChatFocus). Absent = a fresh question. */
  focus?: ChatFocus;
  /** Persistent organizational memory for THIS user (administrators only; the reader refuses everyone else). Absent = not connected. */
  orgMemory?: OrgMemoryReader;
  /** The tool registry this request reads through. Absent = the standard Phase 1 registry. Tests inject a wrapped one. */
  tools?: ToolRegistry;
  /** External connectors for this request. Absent = built from the server environment (live mode only). Tests inject fakes. */
  connectors?: Connectors;
  /** Connections this request may use when the connection framework is on (BROKO_CONNECTION_FRAMEWORK=1). Absent = the default runtime. Tests inject fakes. */
  integrations?: IntegrationRuntime;
}


/** What the browser keeps for display. History is never sent back to the server or used as context. */
export type ChatTurn =
  | { id: number; role: "user"; content: string }
  | { id: number; role: "assistant"; reply: ChatReply }
  | { id: number; role: "error"; content: string };
