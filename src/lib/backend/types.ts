import type { AiMessageView, ErrorCategory, JobStatus, ReviewDecision, ReviewResult } from "@/lib/ai-brain";
import type {
  ActivityEvent, AppNotification, Integration, Person, Profile, Task, TaskCounts, TaskInput, TeamMember,
} from "@/lib/types";

/**
 * Safe-to-show error. Anything else thrown by a backend is treated as internal:
 * it is logged on the server and replaced with a generic message for the user.
 */
export class UserFacingError extends Error {}

/** A decision from the dashboard. The reviewer identity always comes from the session, never from the form. */
export type AiReviewInput =
  | { action: "approve"; assigned_to?: string | null; due_at?: string | null; priority?: Extract<ReviewDecision, { action: "approve" }>["priority"] }
  | { action: "reject" };

/** Dashboard view of a background job. Content-free: no subject, sender or provider message id. */
export interface AiJobView {
  /** Hashed, stable job id (also the correlation id). */
  id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  /** When a queued or waiting job becomes due. */
  next_attempt_at: string;
  error_category: ErrorCategory | null;
  /** Message status reached (e.g. REVIEW_REQUIRED) or "duplicate". Never an approval. */
  outcome: string | null;
  /** Hashed message identity, known once the message has been read. Matches the audit events of that message. */
  workflow_id: string | null;
  /** True if an audit event of this job could not be recorded. */
  audit_failed: boolean;
  requeued_by: string | null;
  requeued_at: string | null;
}

export interface AiInboxView {
  /**
   * "synthetic": built-in sample messages (demo). It is never a live mailbox and the UI must say so.
   * "live": messages from a verified provider through a persistent store (not implemented yet).
   */
  mode: "synthetic" | "live";
  /** Browser-facing view models only: no provider or mailbox identifiers (see ai-brain/view.ts). */
  messages: AiMessageView[];
  /** Background jobs, oldest first. Classification happens in a worker, never while this view is built. */
  jobs: AiJobView[];
  queue: Record<JobStatus, number>;
  /** Messages seen again and suppressed (idempotency). */
  duplicates_suppressed: number;
  /** Which classifier is active, stated explicitly. `note` explains a requested mode that could not be honoured. */
  classifier: { mode: "rules" | "llm"; model: string | null; note: string | null };
}

/** Status counts of AI Inbox messages. No subject, sender, excerpt or any other message content, by construction. */
export interface AiInboxCounts {
  /** Same meaning as `AiInboxView.mode`: "synthetic" is demo data, never a live mailbox. */
  mode: "synthetic" | "live";
  /** Messages per status (e.g. REVIEW_REQUIRED). Statuses with no message are absent. */
  by_status: Record<string, number>;
  total: number;
}

/**
 * Counts only. Used by the chat assistant. An implementation MUST refuse non-administrators before querying anything, and
 * MUST select only the status column, so a member cannot infer inbox counts and nothing readable leaves the database.
 */
export interface AiInboxCountsReader {
  counts(): Promise<AiInboxCounts>;
}

/** Read-only AI Inbox page data. Administrators only. Exposing this does NOT enable approve / reject / process / requeue. */
export interface AiInboxReader {
  view(): Promise<AiInboxView>;
}

/**
 * Write-capable AI Inbox operations. A backend that has not been verified for writes MUST NOT provide this: the page shows
 * approve / reject / process / requeue controls only when `Repo.aiInboxWriter` exists. Implementations must themselves
 * enforce: administrators only, the existing assignment rule, and atomic one-time approval. See docs/ai-brain/INTEGRATION.md.
 */
export interface AiInboxWriter {
  /** Runs the worker once over whatever is due. Administrators only. Never creates tasks. */
  process(): Promise<{ completed: number; retried: number; failed: number }>;
  /** Puts a failed job back in the queue. `jobId` is the public job id (12 hex characters, `AiJobView.id`). Administrators only; records who did it. */
  requeue(jobId: string): Promise<boolean>;
  /** `reviewId` is the opaque id from the view model; the backend maps it to its record. */
  review(reviewId: string, input: AiReviewInput): Promise<ReviewResult>;
}

/** Everything the demo backend implements. Real backends implement the narrower interfaces above, independently. */
export type AiInboxRepo = AiInboxReader & AiInboxCountsReader & AiInboxWriter;

/**
 * Data contract the dashboard needs. A backend (Supabase, AWS, ...) implements this,
 * scoped to the signed-in user, and MUST enforce access control itself: the UI and
 * server actions are not the only line of defence. See docs/BACKEND_INTEGRATION_REQUIREMENTS.md.
 */
export interface Repo {
  /** Tasks the user may see (admins: all; members: assigned to or created by them). */
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(id: string, patch: Partial<TaskInput>): Promise<Task>;
  /** KPI counts over the tasks the user may see. */
  taskCounts(): Promise<TaskCounts>;
  /** Names for assignee/owner pickers. Must not include contact details. */
  listPeople(): Promise<Person[]>;
  listActivity(limit: number): Promise<ActivityEvent[]>;
  listTaskActivity(taskId: string, limit: number): Promise<ActivityEvent[]>;
  listIntegrations(): Promise<Integration[]>;
  /** Aggregate counts per team member (no task contents). */
  teamWorkload(): Promise<TeamMember[]>;
  listNotifications(): Promise<AppNotification[]>;
  /** Read-only AI Inbox page data. Absent when this backend has no AI Inbox persistence ("not connected"). */
  aiInbox?: AiInboxReader;
  /** Counts only, for the chat assistant. Absent = not connected. Independent of `aiInbox`. */
  aiInboxCounts?: AiInboxCountsReader;
  /** Approve / reject / process / requeue. Absent on every backend not verified for writes (all of them except the demo today). */
  aiInboxWriter?: AiInboxWriter;
}

export interface Backend {
  readonly kind: "demo" | "supabase" | "unconfigured";
  /** Validated server-side session -> profile, or null. */
  getCurrentUser(): Promise<Profile | null>;
  signInWithPassword(email: string, password: string): Promise<{ error?: string }>;
  signOut(): Promise<void>;
  repoFor(user: Profile): Promise<Repo>;
  /** Only the demo backend provides this. */
  demo?: {
    accounts: Profile[];
    /** Open sign-in as a placeholder account (synthetic data only; no password). */
    signInAs(id: string): Promise<{ error?: string }>;
    /** Discards this visitor's demo changes. */
    reset(): Promise<void>;
  };
}
