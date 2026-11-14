import type { ChatIntent, SourceId } from "@/lib/ai-brain/chat/types";

// Governed organizational knowledge: domain types shared by the repositories, the service, the pages and the AI Brain.
// Nothing here knows about Supabase, Next.js or the demo; those are adapters behind `KnowledgeRepo`.
//
// Knowledge is what a person deliberately wrote down and an administrator approved. It is never copied from chat, and it is not
// model training: the assistant only retrieves approved, current items.

export const KNOWLEDGE_KINDS = ["decision", "correction", "procedure", "project_note"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KIND_LABEL: Record<KnowledgeKind, string> = { decision: "Decision", correction: "Correction", procedure: "Procedure", project_note: "Project note" };

export const KNOWLEDGE_SCOPES = ["organization", "project"] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];
export const SCOPE_LABEL: Record<KnowledgeScope, string> = { organization: "Whole organization", project: "One project" };

export const KNOWLEDGE_STATUSES = ["proposed", "approved", "rejected", "superseded", "expired"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export const STATUS_LABEL: Record<KnowledgeStatus, string> = {
  proposed: "Proposed (awaiting review)", approved: "Approved", rejected: "Rejected", superseded: "Superseded", expired: "Expired",
};

export type KnowledgeSource = "manual" | "correction";
export type ReviewAction = "approve" | "reject" | "expire";

/** Limits are enforced in the schema, the service and the database CHECK constraints (supabase/proposed/0009). */
export const LIMITS = { title: { min: 3, max: 160 }, body: { min: 10, max: 2000 }, topic: 60, sourceRef: 200, note: 500 } as const;
/** An approved item nobody has reviewed for this long is still used, but is labelled as possibly out of date. */
export const STALE_AFTER_DAYS = 180;

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  project_id: string | null;
  title: string;
  body: string;
  /** Optional short key (lowercase words joined by hyphens). Two current items with the same topic are reported as a conflict. */
  topic: string | null;
  status: KnowledgeStatus;
  author_id: string | null;
  author_name: string | null;
  source_type: KnowledgeSource;
  /** Where the author says this comes from (a meeting, a document title). Free text written by a person; shown, never trusted. */
  source_ref: string | null;
  supersedes_id: string | null;
  effective_from: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

/** "redacted" exists only after the draft migration 0011 (content removed by an administrator); nothing in the app writes it yet. */
export type KnowledgeEventAction = "submitted" | "approved" | "rejected" | "expired" | "superseded" | "redacted";
export interface KnowledgeEvent {
  id: string;
  item_id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: KnowledgeEventAction;
  from_status: KnowledgeStatus | null;
  to_status: KnowledgeStatus;
  note: string | null;
  created_at: string;
}

/** What a person submits. Status, author, timestamps and reviewer are never part of it: they come from the server. */
export interface KnowledgeInput {
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  project_id: string | null;
  title: string;
  body: string;
  topic: string | null;
  source_ref: string | null;
  /** The approved item this one is meant to replace. Nothing is replaced until an administrator approves this item. */
  supersedes_id: string | null;
  /** YYYY-MM-DD, optional. */
  expires_on: string | null;
}

export const FEEDBACK_RATINGS = ["useful", "not_useful"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];
export const FEEDBACK_REASONS = ["wrong", "outdated", "missing", "unclear", "other"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export const REASON_LABEL: Record<FeedbackReason, string> = { wrong: "Wrong", outdated: "Out of date", missing: "Missing information", unclear: "Unclear", other: "Other" };

/** Metadata only. There is no field that can hold the question, the answer or a comment. */
export interface FeedbackInput {
  rating: FeedbackRating;
  reason: FeedbackReason | null;
  intent: ChatIntent | null;
  source_ids: SourceId[];
}

export interface ReviewFilter {
  status?: KnowledgeStatus;
  limit?: number;
}
