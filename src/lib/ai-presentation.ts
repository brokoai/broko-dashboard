import type { ErrorCategory, JobStatus } from "@/lib/ai-brain/schema";
import type { AiMessageView } from "@/lib/ai-brain/view";
import type { AiJobView } from "@/lib/backend/types";

/** Pure presentation rules for the AI Inbox (no React), so they are testable and cannot crash a page. */
export type Tone = "neutral" | "red" | "amber" | "blue" | "green";

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "blue" },
  processing: { label: "Processing", tone: "blue" },
  retry_wait: { label: "Retry scheduled", tone: "amber" },
  completed: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

export const ERROR_LABEL: Record<ErrorCategory, string> = {
  invalid_input: "the email could not be read",
  classification_failed: "classification failed",
  invalid_model_output: "the AI output was rejected",
  task_creation_failed: "the task could not be created",
  task_creation_denied: "task creation was not permitted",
  notification_failed: "the owner could not be notified",
  processing_interrupted: "processing was interrupted",
  internal_error: "an internal error occurred",
};

/** A status or category this build does not know still renders. */
export const jobStatusBadge = (status: string): { label: string; tone: Tone } => (JOB_STATUS as Record<string, { label: string; tone: Tone }>)[status] ?? { label: "Unknown", tone: "neutral" };
export const errorLabel = (c: string | null): string => (c && (ERROR_LABEL as Record<string, string>)[c]) || "unknown cause";

/** True while the page should keep refreshing (something is still being worked on or is due for a retry). */
export const queueActive = (queue: Record<string, number>): boolean => (queue.queued ?? 0) + (queue.processing ?? 0) + (queue.retry_wait ?? 0) > 0;

/** One honest sentence about a job. Never claims completion for a job that has not completed, and never mentions approval. */
export function jobSummary(j: Pick<AiJobView, "status" | "attempts" | "max_attempts" | "next_attempt_at" | "error_category" | "outcome">, nowMs: number): string {
  switch (j.status) {
    case "queued": return "Waiting for the background worker.";
    case "processing": return `Being processed (attempt ${j.attempts} of ${j.max_attempts}).`;
    case "retry_wait": {
      const s = Math.max(0, Math.ceil((Date.parse(j.next_attempt_at) - nowMs) / 1000));
      return `Attempt ${j.attempts} of ${j.max_attempts} failed (${errorLabel(j.error_category)}). Next try ${s > 0 ? `in about ${s}s` : "is due now"}.`;
    }
    case "completed": return j.outcome === "duplicate" ? "Completed: a copy of a message already processed." : `Completed after ${j.attempts} attempt${j.attempts === 1 ? "" : "s"}. A person still decides what happens next.`;
    case "failed": return `Failed after ${j.attempts} attempt${j.attempts === 1 ? "" : "s"}: ${errorLabel(j.error_category)}. An administrator can retry it.`;
    default: return "Unknown state.";
  }
}

/** Suggested (rule-based) versus confirmed (human) ownership. The suggestion never becomes "confirmed" without a recorded reviewer. */
export function ownerSummary(m: Pick<AiMessageView, "owner" | "confirmed_owner" | "reviewed_by" | "reviewed_at" | "status">, nameOf: (id: string | null) => string) {
  const suggested = m.owner.user_id ? nameOf(m.owner.user_id) : "none";
  const c = m.confirmed_owner;
  return {
    suggested,
    suggestedBecause: m.owner.reason,
    confirmed: c ? (c.user_id ? nameOf(c.user_id) : "unassigned") : null,
    confirmedBy: c ? nameOf(c.confirmed_by) : null,
    confirmedAt: c?.confirmed_at ?? null,
    changedByReviewer: c !== null && c.user_id !== m.owner.user_id,
    decision: m.status === "REJECTED" ? ("rejected" as const) : c ? ("approved" as const) : null,
    decidedBy: m.reviewed_by ? nameOf(m.reviewed_by) : null,
    decidedAt: m.reviewed_at,
  };
}
