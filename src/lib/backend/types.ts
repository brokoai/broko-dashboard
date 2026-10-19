import type {
  ActivityEvent, AppNotification, Integration, Person, Profile, Task, TaskCounts, TaskInput, TeamMember,
} from "@/lib/types";

/**
 * Safe-to-show error. Anything else thrown by a backend is treated as internal:
 * it is logged on the server and replaced with a generic message for the user.
 */
export class UserFacingError extends Error {}

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
    /** True when an access code (server-side secret) must be entered to sign in. */
    codeRequired: boolean;
    signInAs(id: string, code: string): Promise<{ error?: string }>;
    /** Discards this visitor's demo changes. */
    reset(): Promise<void>;
  };
}
