import {
  DEFAULT_POLICY, SYNTHETIC_NOW, TaskSinkDenied, describeAudit, reviewMessage, rulesSelection, sourceRef, toActivityEvents, toMessageView,
  type AiMessageView, type AuditEvent, type ClassifierSelection, type JobRecord, type JobStatus, type PipelineDeps, type ReviewDecision, type TaskSink,
} from "@/lib/ai-brain";
import { InMemoryAuditSink } from "@/lib/ai-brain";
import { checkTaskChange } from "@/lib/permissions";
import type { ActivityEvent, Profile, TaskInput } from "@/lib/types";
import { UserFacingError, type AiInboxCounts, type AiInboxRepo, type AiInboxView, type AiJobView, type AiReviewInput } from "../types";
import { DEMO_FIXTURES, DEMO_OWNER_RULES, fixtureKeys, runtimeFor, type DemoAiRuntime } from "./ai-runtime";
import { LIMITS } from "./state";
import { DEMO_USERS } from "./users";

export { DEMO_FIXTURES, DEMO_OWNER_RULES };

/**
 * DEMO ONLY. The synthetic AI Inbox. The page and this repo only READ the shared runtime (see ai-runtime.ts): messages are
 * classified by the background worker, never while a view is built. Each visitor's decisions persist only in their demo
 * cookie (24 h): an approval IS the task (deterministic id; it records who created it, for whom, and when); a rejection is
 * stored with its reviewer and time. Nothing here reads a mailbox, and the UI labels the data as synthetic.
 */

/** What the visitor's storage can tell us, and how it records a decision. Implemented by the demo repo. */
export interface DemoAiHost {
  user: Profile;
  now(): number;
  /**
   * Decisions this visitor made. Approvals ARE the created tasks (who created them and when is recorded there);
   * rejections are stored with the reviewer and time. Both last as long as the demo cookie (24 h) and are
   * discarded by "Reset demo". They are not a database.
   */
  decisions(): Promise<{
    approved: { index: number; task_id: string; title: string; actor_id: string; assigned_to: string | null; at: string }[];
    rejected: { index: number; actor_id: string; at: string }[];
  }>;
  /** Idempotent on `index`: a repeat returns the existing task with created: false. */
  createTask(input: TaskInput, index: number): Promise<{ task_id: string; created: boolean }>;
  /** Records the rejection with the current user and time. */
  reject(index: number): Promise<void>;
}

const DAY = 86_400_000;
const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Workflow ids of the sample messages, computed without any classification. */
const workflowIds = (): string[] => fixtureKeys().map(sourceRef);

function decisionEvent(workflow_id: string, decision: "approved" | "rejected", actorId: string, at: string, task_id: string | null): AuditEvent {
  const e = {
    event_type: "message_classified" as const, status: "processed" as const, stage: "audit" as const, at, workflow_id, task_id,
    classifier: null, intent: null, outcome: decision === "approved" ? ("APPROVED" as const) : ("REJECTED" as const), flags: [],
    error_category: null, actor: { kind: "user" as const, id: actorId }, decision, attempt: null,
  };
  return { ...e, description: describeAudit(e) };
}

const toJobView = (j: JobRecord): AiJobView => ({
  id: j.id, status: j.status, attempts: j.attempts, max_attempts: j.max_attempts, next_attempt_at: j.next_attempt_at, error_category: j.error_category,
  outcome: j.outcome, workflow_id: j.workflow_id, audit_failed: j.audit_failed, requeued_by: j.requeued_by, requeued_at: j.requeued_at,
});

/** Tests and local use without an explicit selection share one rules-mode runtime. */
const DEFAULT_SELECTION = rulesSelection();

export function createDemoAiInbox(
  host: DemoAiHost,
  selection: ClassifierSelection = DEFAULT_SELECTION,
  runtime: DemoAiRuntime = runtimeFor(selection),
): AiInboxRepo & { activity(withPipeline?: boolean): Promise<ActivityEvent[]> } {
  const { user } = host;
  const requireAdmin = () => {
    if (user.role !== "admin") throw new UserFacingError("Only administrators can use the AI Inbox.");
  };

  /** A private copy of the shared records with THIS visitor's decisions applied. The shared runtime is never modified. */
  async function withDecisions() {
    const store = runtime.records.clone();
    const keys = fixtureKeys();
    const d = await host.decisions();
    for (const a of d.approved) {
      const key = keys[a.index];
      if (key && (await store.get(key))) {
        await store.update(key, {
          status: "TASK_CREATED", task_id: a.task_id, reviewed_by: a.actor_id, reviewed_at: a.at,
          confirmed_owner: { user_id: a.assigned_to, confirmed_by: a.actor_id, confirmed_at: a.at },
        });
      }
    }
    for (const r of d.rejected) {
      const key = keys[r.index];
      if (key && (await store.get(key))) await store.update(key, { status: "REJECTED", reviewed_by: r.actor_id, reviewed_at: r.at });
    }
    return { store, keys };
  }

  /**
   * Activity-feed events. Pipeline events come from the shared worker's audit sink (idempotent, so retries never duplicate
   * them), stamped relative to "now" so they sort like the sample tasks. Decision events are derived ONLY from what was
   * really recorded: the creator of an approved task, the reviewer and time of a rejection. Events from a review call
   * itself are not kept, because a request-scoped sink cannot be durable and we do not pretend it is.
   * Non-admins never see pipeline events; they only see decision events for tasks they can already see.
   */
  async function activity(withPipeline = true): Promise<ActivityEvent[]> {
    const ids = workflowIds();
    const d = await host.decisions();
    const decided: AuditEvent[] = [
      ...d.approved.map((a) => decisionEvent(ids[a.index], "approved", a.actor_id, a.at, a.task_id)),
      ...d.rejected.map((r) => decisionEvent(ids[r.index], "rejected", r.actor_id, r.at, null)),
    ];
    const title = new Map(d.approved.map((a) => [a.task_id, a.title]));
    const out = toActivityEvents(decided, { idPrefix: "aid", at: (_i, e) => e.at, taskTitle: (id) => title.get(id) ?? null });
    if (withPipeline && user.role === "admin") {
      const base = Math.floor(host.now() / DAY) * DAY - DAY + 9 * 3_600_000;
      out.push(...toActivityEvents(runtime.audit.events, { idPrefix: "ai", at: (i) => new Date(base + i * 1000).toISOString() }));
    }
    return out;
  }

  return {
    activity,

    async view(): Promise<AiInboxView> {
      requireAdmin();
      await runtime.ensureQueued(); // enqueue only: reads no content and classifies nothing
      const jobs = await runtime.jobs.list(100);
      const { store } = await withDecisions();
      const queue = { queued: 0, processing: 0, retry_wait: 0, completed: 0, failed: 0 } as Record<JobStatus, number>;
      for (const j of jobs) queue[j.status]++;
      // A message whose job is still queued, running or waiting to retry is shown as a job, not as a (possibly half-done or
      // temporarily FAILED) message. Only finished jobs (completed, or terminally failed) expose their message.
      const finished = new Set(jobs.filter((j) => (j.status === "completed" || j.status === "failed") && j.workflow_id).map((j) => j.workflow_id));
      // Only the allow-listed view model leaves this repo: provider references stay with the records.
      const messages: AiMessageView[] = (await store.list(100)).filter((m) => finished.has(sourceRef(m.dedupe_key))).map(toMessageView);
      return {
        mode: "synthetic", messages, jobs: jobs.map(toJobView), queue,
        duplicates_suppressed: jobs.filter((j) => j.outcome === "duplicate").length,
        classifier: { mode: selection.mode, model: selection.model, note: selection.note },
      };
    },

    /** Admin check first. Only statuses are tallied; the view model is dropped before anything is returned. */
    async counts(): Promise<AiInboxCounts> {
      requireAdmin();
      const { messages, mode } = await this.view();
      const by_status: Record<string, number> = {};
      for (const m of messages) by_status[m.status] = (by_status[m.status] ?? 0) + 1;
      return { mode, by_status, total: messages.length };
    },

    async process() {
      requireAdmin();
      await runtime.ensureQueued();
      const s = await runtime.drain();
      return { completed: s.completed, retried: s.retried, failed: s.failed };
    },

    async requeue(jobId) {
      requireAdmin();
      return runtime.jobs.requeue(jobId, user.id, runtime.now());
    },

    async review(reviewId, input: AiReviewInput) {
      // Authorize BEFORE reading anything: a non-admin must not learn whether a message exists.
      if (user.role !== "admin") return { ok: false, error: "forbidden", message: "Only administrators can review AI-proposed tasks." };
      const { store, keys } = await withDecisions();
      // The browser only knows the opaque review id. The dedupe key stays here, server-side.
      const target = (await store.list(100)).find((m) => m.review_id === reviewId);
      if (!target) return { ok: false, error: "not_found", message: "Message not found." };
      const dedupeKey = target.dedupe_key;
      const sink: TaskSink = {
        async createTask(taskInput, ctx) {
          if (ctx.actor.kind !== "user") throw new TaskSinkDenied("Automatic task creation is not available in the demo.");
          const denied = checkTaskChange(ctx.actor.profile, null, { assigned_to: taskInput.assigned_to });
          if (denied) throw new TaskSinkDenied(denied);
          const index = keys.indexOf(ctx.dedupe_key);
          if (index < 0) throw new TaskSinkDenied("Unknown message.");
          try {
            // The demo's per-visitor storage is tiny, so it keeps shortened task text.
            return await host.createTask({ ...taskInput, title: clipTo(taskInput.title, LIMITS.title), description: taskInput.description === null ? null : clipTo(taskInput.description, LIMITS.description) }, index);
          } catch (e) {
            if (e instanceof UserFacingError) throw new TaskSinkDenied(e.message);
            throw e;
          }
        },
      };
      // `audit` is request-scoped: review events are rebuilt from the stored decisions instead (see activity()).
      const deps: PipelineDeps = {
        classifier: selection.classifier, store, audit: new InMemoryAuditSink(), taskSink: sink,
        ownerRules: DEMO_OWNER_RULES, assignable: new Set(DEMO_USERS.map((u) => u.id)), policy: DEFAULT_POLICY, now: () => SYNTHETIC_NOW,
      };
      const decision: ReviewDecision = input.action === "reject"
        ? { action: "reject", by: user }
        : { action: "approve", by: user, assigned_to: input.assigned_to, due_at: input.due_at, priority: input.priority };
      const result = await reviewMessage(deps, dedupeKey, decision);
      const index = keys.indexOf(dedupeKey);
      if (result.ok && input.action === "reject" && index >= 0) await host.reject(index);
      return result;
    },
  };
}
