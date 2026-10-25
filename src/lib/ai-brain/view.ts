import { createHash } from "node:crypto";
import type { ProcessedMessage } from "./schema";
import { sourceRef } from "./task-mapping";

/**
 * What the browser may know about an AI message.
 *
 * The record in the store carries provider references (dedupe key, source and Internet Message-ID, mailbox reference).
 * Those stay server-side. The browser gets an OPAQUE `review_id` (an unguessable-looking UUID that reveals nothing about
 * the message) for list identity and for approve/reject, and an explicit allow-list of fields. `toMessageView` copies fields
 * one by one: a field added to ProcessedMessage later is NOT exposed until someone adds it here on purpose.
 */

/**
 * A stable, one-way UUID for a message, derived from its dedupe key. Stable so every serverless instance computes the same
 * id for the same message (the demo has no shared store); one-way because it is a SHA-256 of a domain-separated string.
 * Shaped as an RFC 4122 v4 UUID so it passes standard UUID validation. A database implementation uses the
 * `ai_messages.review_id` column (random by default) instead; the same type reaches the browser either way.
 */
export function reviewIdFor(dedupeKey: string): string {
  const h = createHash("sha256").update(`broko|review-id|${dedupeKey}`).digest("hex");
  const variant = "89ab"[parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Shape check for an id coming back from the browser (untrusted). Existence is decided by the backend. */
export const isValidReviewId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface AiMessageView {
  /** Opaque id: list identity and the handle for approve/reject. */
  review_id: string;
  /** Hashed, content-free correlation id (links the message to its job and audit events). */
  workflow_id: string;
  status: ProcessedMessage["status"];
  subject: string;
  sender_name: string | null;
  /** The sender is shown to the administrator who reviews the message. It is not a provider or mailbox identifier. */
  sender_email: string;
  received_at: string;
  classifier: { mode: "rules" | "llm"; fallback_reason: "model_output_invalid" | "model_unavailable" | null } | null;
  analysis: ProcessedMessage["analysis"];
  risk_flags: ProcessedMessage["risk_flags"];
  owner: { user_id: string | null; reason: string };
  confirmed_owner: ProcessedMessage["confirmed_owner"];
  review_reasons: string[];
  /** How many AI claims grounding removed. The notes themselves stay server-side. */
  grounding_removed: number;
  proposed_priority: ProcessedMessage["proposed_priority"];
  proposed_due_at: string | null;
  task_id: string | null;
  notification: ProcessedMessage["notification"];
  reviewed_by: string | null;
  reviewed_at: string | null;
  error: ProcessedMessage["error"];
}

export function toMessageView(m: ProcessedMessage): AiMessageView {
  return {
    review_id: m.review_id,
    workflow_id: sourceRef(m.dedupe_key),
    status: m.status,
    subject: m.subject,
    sender_name: m.sender_name,
    sender_email: m.sender_email,
    received_at: m.received_at,
    classifier: m.classifier ? { mode: m.classifier.mode, fallback_reason: m.classifier.fallback_reason } : null,
    analysis: m.analysis,
    risk_flags: m.risk_flags,
    owner: { user_id: m.owner.user_id, reason: m.owner.reason },
    confirmed_owner: m.confirmed_owner,
    review_reasons: m.review_reasons,
    grounding_removed: m.grounding_notes.length,
    proposed_priority: m.proposed_priority,
    proposed_due_at: m.proposed_due_at,
    task_id: m.task_id,
    notification: m.notification,
    reviewed_by: m.reviewed_by,
    reviewed_at: m.reviewed_at,
    error: m.error,
  };
}
