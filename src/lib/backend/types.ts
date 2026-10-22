import type { ProcessedMessage, ReviewDecision, ReviewResult } from "@/lib/ai-brain";
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

export interface AiInboxView {
  /**
   * "synthetic": built-in sample messages (demo). It is never a live mailbox and the UI must say so.
   * "live": messages from a verified provider through a persistent store (not implemented yet).
   */
  mode: "synthetic" | "live";
  messages: ProcessedMessage[];
  /** Messages seen again and suppressed (idempotency). */
  duplicates_suppressed: number;
  /** Which classifier is active, stated explicitly. `note` explains a requested mode that could not be honoured. */
  classifier: { mode: "rules" | "llm"; model: string | null; note: string | null };
}

/**
 * AI Inbox access. OPTIONAL: a backend without it (e.g. Supabase before migration 0003 is approved)
 * shows "not connected". Implementations must themselves enforce: administrators only, the existing
 * assignment rule, and atomic one-time approval. See docs/ai-brain/INTEGRATION.md.
 */
export interface AiInboxRepo {
  view(): Promise<AiInboxView>;
  review(dedupeKey: string, input: AiReviewInput): Promise<ReviewResult>;
}

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
  /** Absent when this backend has no AI Inbox persistence. */
  aiInbox?: AiInboxRepo;
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
