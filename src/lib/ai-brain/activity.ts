import { z } from "zod";
import type { ActivityEvent, ActivityMetadata, EventStatus } from "@/lib/types";
import type { AuditEvent } from "./ports";
import { AUDIT_DECISIONS, ERROR_CATEGORIES, FALLBACK_REASONS, INTENTS, PROCESSING_STATUSES, RISK_FLAGS, type ErrorCategory } from "./schema";

/**
 * AI audit events -> the dashboard's existing Activity feed.
 *
 * Privacy by construction: descriptions are produced HERE from typed enums, so no emitter can put
 * message content in them (not the subject, not the AI-written task title, not an error message).
 * Everything an event carries is an enum, a number, a hashed reference, or an internal id.
 */

const CATEGORY_LABEL: Record<ErrorCategory, string> = {
  invalid_input: "the email could not be read",
  classification_failed: "classification failed",
  invalid_model_output: "the AI output was rejected",
  task_creation_failed: "the task could not be created",
  task_creation_denied: "task creation was not permitted",
  notification_failed: "the owner could not be notified",
  processing_interrupted: "processing was interrupted",
  internal_error: "an internal error occurred",
};

/** Fixed-vocabulary description. The only text that reaches the Activity feed from the AI workflow. */
export function describeAudit(e: Pick<AuditEvent, "event_type" | "decision" | "outcome" | "intent" | "classifier" | "error_category" | "status">): string {
  if (e.decision === "approved") return "Proposal approved by a reviewer";
  if (e.decision === "rejected") return "Proposal rejected by a reviewer";
  switch (e.event_type) {
    case "email_received": return "Email received";
    case "message_classified": {
      const how = !e.classifier ? "" : e.classifier.fallback_reason ? " (rules; AI model not used)" : e.classifier.mode === "llm" ? " (AI model)" : " (rules)";
      return `Classified as ${(e.intent ?? "unknown").replace(/_/g, " ")}${how}`;
    }
    case "potential_task_identified": return e.outcome === "REVIEW_REQUIRED" ? "Potential task identified; awaiting human review" : "Potential task identified";
    case "task_created": return "Task created from email";
    case "notification_sent": return "Owner notified";
    case "workflow_failed": {
      const why = e.error_category ? CATEGORY_LABEL[e.error_category] : "unknown cause";
      return e.status === "pending" ? `Attempt failed, will retry: ${why}` : `Workflow failed: ${why}`;
    }
    default: return "AI workflow event";
  }
}

/** Strict shape of the typed metadata, also used to validate `activity_events.metadata` read back from a database. */
export const ActivityMetadataSchema = z.strictObject({
  workflow_id: z.string().regex(/^[0-9a-f]{12}$/).nullable(),
  classifier_mode: z.enum(["rules", "llm"]).nullable(),
  fallback_reason: z.enum(FALLBACK_REASONS).nullable(),
  intent: z.enum(INTENTS).nullable(),
  outcome: z.enum(PROCESSING_STATUSES).nullable(),
  flags: z.array(z.enum(RISK_FLAGS)).max(12),
  error_category: z.enum(ERROR_CATEGORIES).nullable(),
  decision: z.enum(AUDIT_DECISIONS).nullable(),
  actor_kind: z.enum(["user", "system"]).nullable(),
});

/** Never throws: anything that is not exactly the typed shape is dropped (the event itself still renders). */
export const parseActivityMetadata = (raw: unknown): ActivityMetadata | undefined => {
  const r = ActivityMetadataSchema.safeParse(raw);
  return r.success ? r.data : undefined;
};

export const metadataOf = (e: AuditEvent): ActivityMetadata => ({
  workflow_id: e.workflow_id,
  classifier_mode: e.classifier?.mode ?? null,
  fallback_reason: e.classifier?.fallback_reason ?? null,
  intent: e.intent,
  outcome: e.outcome,
  flags: e.flags,
  error_category: e.error_category,
  decision: e.decision,
  actor_kind: e.actor?.kind ?? null,
});

/**
 * Maps audit events onto ActivityEvent. `task_created` AI events are NOT mapped when the backend already
 * records its own `task_created` for the same task (the demo repo and the database triggers both do),
 * so the feed never shows the same action twice. Timestamps are assigned by the caller.
 */
export function toActivityEvents(
  events: readonly AuditEvent[],
  opts: { idPrefix: string; at: (index: number, e: AuditEvent) => string; taskTitle?: (taskId: string) => string | null },
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  events.forEach((e, i) => {
    if (e.event_type === "task_created" && e.task_id) return;
    out.push({
      id: `${opts.idPrefix}-${e.workflow_id ?? "none"}-${i}`,
      event_type: e.event_type,
      description: describeAudit(e),
      status: e.status as EventStatus,
      actor_id: e.actor?.kind === "user" ? e.actor.id : null,
      related_task_id: e.task_id,
      related_task_title: e.task_id ? opts.taskTitle?.(e.task_id) ?? null : null,
      created_at: opts.at(i, e),
      metadata: metadataOf(e),
    });
  });
  return out;
}
